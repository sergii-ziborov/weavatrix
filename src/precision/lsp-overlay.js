import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "../graph/file-lock.js";
import { edgeProvenance } from "../graph/edge-provenance.js";
import { isStructuralRelation } from "../graph/relations.js";
import { createRepoBoundary, isPathInside } from "../repo-path.js";
import {
  classifyTypeScriptReferenceUsage,
  createTypeScriptLspClient,
  typeScriptLspContract,
  typeScriptProjectSafety,
} from "./typescript-lsp-provider.js";

export const PRECISION_OVERLAY_V = 3;
export const PRECISION_FILE = "precision.json";

const JS_TS_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const endpoint = (value) => String(value && typeof value === "object" ? value.id : value);
const norm = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const graphMode = (graph) => ["full", "no-tests", "tests-only"].includes(graph?.graphBuildMode)
  ? graph.graphBuildMode : "full";
const graphScope = (graph) => String(graph?.graphBuildScope || "");
const precisionMode = (graph) => graph?.graphPrecisionMode === "off" ? "off" : "lsp";
const providerContractFor = (graph) => precisionMode(graph) === "off" ? "off" : typeScriptLspContract();
const graphContractFor = (graph) => ({
  extractorSchemaV: Number(graph?.extractorSchemaV) || 0,
  ...(graph?.repositoryFreshnessBuilderVersion != null
    ? {repositoryFreshnessBuilderVersion: String(graph.repositoryFreshnessBuilderVersion)} : {}),
  ...(graph?.graphBuilderVersion != null ? {graphBuilderVersion: String(graph.graphBuilderVersion)} : {}),
  ...(graph?.internalBuilderVersion != null ? {internalBuilderVersion: String(graph.internalBuilderVersion)} : {}),
});
const lineNumber = (value) => {
  const match = /L(\d+)/.exec(String(value || ""));
  return match ? Number(match[1]) : 0;
};

export function precisionPathForGraph(graphPath) {
  return resolve(dirname(graphPath), PRECISION_FILE);
}

function sameRequest(actual, expected) {
  if (!expected) return true;
  return Number(actual?.maxSymbols) === Number(expected.maxSymbols)
    && Number(actual?.maxReferences) === Number(expected.maxReferences)
    && Number(actual?.maxLinks) === Number(expected.maxLinks);
}

function sameGraphContract(actual, graph) {
  const expected = graphContractFor(graph);
  if (!actual || typeof actual !== "object") return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function precisionOverlayMatches(overlay, graph, { request } = {}) {
  return Number(overlay?.precisionOverlayV) === PRECISION_OVERLAY_V
    && String(overlay?.baseGraphRevision || "") === String(graph?.graphRevision || "")
    && String(overlay?.graphBuildMode || "full") === graphMode(graph)
    && String(overlay?.graphBuildScope || "") === graphScope(graph)
    && String(overlay?.precisionMode || "") === precisionMode(graph)
    && String(overlay?.providerContract || "") === providerContractFor(graph)
    && sameGraphContract(overlay?.graphContract, graph)
    && sameRequest(overlay?.request, request);
}

export function readPrecisionOverlay(graphPath, graph) {
  const path = precisionPathForGraph(graphPath);
  if (!existsSync(path)) return null;
  try {
    const overlay = JSON.parse(readFileSync(path, "utf8"));
    return precisionOverlayMatches(overlay, graph) ? overlay : null;
  } catch {
    return null;
  }
}

export function precisionSummary(overlay) {
  if (!overlay) return {
    state: "UNAVAILABLE",
    provider: null,
    verifiedEdges: 0,
    candidates: 0,
    queried: 0,
    reason: "no revision-matched precision overlay",
  };
  const engine = Array.isArray(overlay.engines) ? overlay.engines[0] : null;
  return {
    state: String(overlay.state || "UNAVAILABLE"),
    provider: engine?.provider || null,
    providerVersion: engine?.version || null,
    typescriptVersion: engine?.typescriptVersion || null,
    verifiedEdges: Number(overlay.coverage?.verifiedEdges) || 0,
    candidates: Number(overlay.coverage?.candidates) || 0,
    selected: Number(overlay.coverage?.selected) || 0,
    queried: Number(overlay.coverage?.queried) || 0,
    references: Number(overlay.coverage?.references) || 0,
    unclassifiedReferences: Number(overlay.coverage?.unclassifiedReferences) || 0,
    referenceEvidence: Array.isArray(overlay.referenceEvidence) ? overlay.referenceEvidence.length : 0,
    truncated: overlay.coverage?.truncated === true,
    reason: overlay.reason || engine?.reason || null,
    noReferenceSymbols: Array.isArray(overlay.noReferenceSymbols) ? overlay.noReferenceSymbols.length : 0,
  };
}

// Precision evidence is revision-bound and lives beside graph.json. The static graph stays pristine
// for Git/history diffs; ordinary graph reads merge only an overlay that matches revision + mode.
export function mergePrecisionOverlay(graph, overlay) {
  if (!precisionOverlayMatches(overlay, graph)) return {...graph, precision: precisionSummary(null)};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const ids = new Set(nodes.map((node) => String(node.id)));
  const links = (Array.isArray(graph.links) ? graph.links : []).map((link) => ({...link}));
  const exactLinks = Array.isArray(overlay.links) ? overlay.links : [];
  for (const exact of exactLinks) {
    const source = endpoint(exact.source);
    const target = endpoint(exact.target);
    if (!ids.has(source) || !ids.has(target) || source === target) continue;
    const relation = String(exact.relation || "references");
    const exactLine = Number.isInteger(exact.line) ? exact.line : null;
    const exactCharacter = Number.isInteger(exact.character) ? exact.character : null;
    let matched = false;
    for (const link of links) {
      // Static topology remains static. Deduplicate only an already-materialized semantic
      // occurrence; never mutate an EXTRACTED/RESOLVED/INFERRED edge into EXACT_LSP.
      if (edgeProvenance(link) !== "EXACT_LSP") continue;
      if (endpoint(link.source) !== source || endpoint(link.target) !== target || String(link.relation || "") !== relation) continue;
      if (exactLine != null && (!Number.isInteger(link.line) || link.line !== exactLine)) continue;
      // Never bless a line-only static edge with an occurrence-specific semantic result. A single
      // source line can contain both type-only and runtime uses of the same symbol.
      if (exactCharacter != null && (!Number.isInteger(link.character) || link.character !== exactCharacter)) continue;
      link.provenance = "EXACT_LSP";
      link.confidence = "EXACT_LSP";
      link.precisionProvider = String(exact.provider || "typescript-language-server");
      if (exact.typeOnly === true) link.typeOnly = true;
      else delete link.typeOnly;
      if (exact.compileOnly === true) link.compileOnly = true;
      else delete link.compileOnly;
      matched = true;
      break;
    }
    if (!matched) {
      links.push({
        source,
        target,
        relation: relation || "references",
        provenance: "EXACT_LSP",
        confidence: "EXACT_LSP",
        precisionProvider: String(exact.provider || "typescript-language-server"),
        ...(exact.typeOnly === true ? {typeOnly: true} : {}),
        ...(exact.compileOnly === true ? {compileOnly: true} : {}),
        ...(exactLine != null ? {line: exactLine} : {}),
        ...(exactCharacter != null ? {character: exactCharacter} : {}),
        ...(Number.isInteger(exact.endLine) ? {endLine: exact.endLine} : {}),
        ...(Number.isInteger(exact.endCharacter) ? {endCharacter: exact.endCharacter} : {}),
      });
    }
  }
  return {
    ...graph,
    links,
    precisionOverlayV: PRECISION_OVERLAY_V,
    precision: precisionSummary(overlay),
    precisionNoReferenceSymbols: Array.isArray(overlay.noReferenceSymbols)
      ? overlay.noReferenceSymbols.filter((id) => ids.has(String(id))).map(String)
      : [],
    precisionReferenceEvidence: Array.isArray(overlay.referenceEvidence)
      ? overlay.referenceEvidence.filter((evidence) => ids.has(endpoint(evidence.source))
        && ids.has(endpoint(evidence.target)))
        .map((evidence) => ({
          source: endpoint(evidence.source),
          target: endpoint(evidence.target),
          ...(Number.isInteger(evidence.line) ? {line: evidence.line} : {}),
          ...(Number.isInteger(evidence.character) ? {character: evidence.character} : {}),
          classification: String(evidence.classification || "unknown"),
          provider: String(evidence.provider || "typescript-language-server"),
        }))
      : [],
  };
}

function repoFileFromLocation(repoRoot, location) {
  if (location?.file) {
    try {
      const root = realpathSync.native(repoRoot);
      const path = realpathSync.native(resolve(root, String(location.file)));
      if (!isPathInside(root, path)) return null;
      const rel = relative(root, path);
      return rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? norm(rel) : null;
    } catch {
      return null;
    }
  }
  const uri = typeof location === "string" ? location : location?.uri || location?.targetUri;
  if (!uri || !String(uri).startsWith("file:")) return null;
  try {
    const root = realpathSync.native(repoRoot);
    const path = realpathSync.native(fileURLToPath(uri));
    if (!isPathInside(root, path)) return null;
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return norm(rel);
  } catch {
    return null;
  }
}

function locationStart(location) {
  return location?.range?.start || location?.targetSelectionRange?.start || location?.targetRange?.start || null;
}

function symbolIndex(graph) {
  const files = new Set();
  const byFile = new Map();
  for (const node of graph.nodes || []) {
    const id = String(node.id);
    const file = norm(node.source_file || (id.includes("#") ? id.slice(0, id.indexOf("#")) : id));
    if (!file) continue;
    if (!id.includes("#")) files.add(file);
    else {
      const start = lineNumber(node.source_location) || Number(node.selection_start?.line) + 1 || 0;
      const end = lineNumber(node.source_end) || start;
      if (!start) continue;
      const sourceRange = node.source_range;
      const hasRange = Number.isInteger(sourceRange?.start?.line)
        && Number.isInteger(sourceRange?.start?.character)
        && Number.isInteger(sourceRange?.end?.line)
        && Number.isInteger(sourceRange?.end?.character);
      const rows = byFile.get(file) || [];
      rows.push({
        id,
        start,
        end: Math.max(start, end),
        ...(hasRange ? {range: sourceRange} : {}),
      });
      byFile.set(file, rows);
    }
  }
  for (const rows of byFile.values()) rows.sort((a, b) => {
    if (a.range && b.range) {
      // The innermost containing range starts latest; equal starts end earliest.
      return comparePosition(b.range.start, a.range.start)
        || comparePosition(a.range.end, b.range.end)
        || a.id.localeCompare(b.id);
    }
    return (a.end - a.start) - (b.end - b.start) || b.start - a.start || a.id.localeCompare(b.id);
  });
  return {files, byFile};
}

const comparePosition = (left, right) => left.line - right.line || left.character - right.character;

function sourceAt(index, file, position) {
  if (!Number.isInteger(position?.line) || !Number.isInteger(position?.character)) {
    return index.files.has(file) ? file : null;
  }
  const line = position.line + 1;
  const rows = (index.byFile.get(file) || []).filter((row) => row.range
    // LSP ranges are start-inclusive and end-exclusive.
    ? comparePosition(row.range.start, position) <= 0 && comparePosition(position, row.range.end) < 0
    // Legacy graphs have line-only ranges. Refuse boundary lines rather than assigning an import,
    // declaration, or trailing token to a coincidentally adjacent symbol.
    : row.start < line && line < row.end);
  if (rows.length) {
    const first = rows[0];
    const span = first.range ? null : first.end - first.start;
    const tied = rows.filter((row) => {
      if (first.range || row.range) return Boolean(first.range && row.range
        && comparePosition(first.range.start, row.range.start) === 0
        && comparePosition(first.range.end, row.range.end) === 0);
      return row.end - row.start === span;
    });
    if (tied.length === 1) return tied[0].id;
  }
  return index.files.has(file) ? file : null;
}

function eligibleTargets(graph, limit) {
  const byId = new Map((graph.nodes || []).map((node) => [String(node.id), node]));
  const ranked = new Map();
  const inbound = new Set();
  for (const link of graph.links || []) {
    const relation = String(link.relation || "");
    if (!isStructuralRelation(relation)) inbound.add(endpoint(link.target));
    if (isStructuralRelation(relation) || !["calls", "references", "inherits", "implements"].includes(relation)) continue;
    if (edgeProvenance(link) === "EXACT_LSP") continue;
    const target = endpoint(link.target);
    const node = byId.get(target);
    if (!node?.selection_start || !JS_TS_FILE.test(String(node.source_file || ""))) continue;
    const score = (relation === "calls" ? 30 : relation === "inherits" || relation === "implements" ? 20 : 10)
      + (edgeProvenance(link) === "INFERRED" ? 8 : 0);
    ranked.set(target, Math.max(ranked.get(target) || 0, score));
  }
  // After ambiguous positive edges, spend the remaining bounded budget on genuinely orphaned
  // internal callables. This is the only route to an exact no-reference dead-code result; public
  // exports remain conservative because consumers may live outside this workspace.
  const orphans = new Set();
  for (const node of byId.values()) {
    const id = String(node.id);
    const visibility = String(node.visibility || "").toLowerCase();
    if (!node.selection_start || !JS_TS_FILE.test(String(node.source_file || "")) || inbound.has(id)) continue;
    if (node.exported === true || visibility === "public" || visibility === "protected") continue;
    if (!/\(\)$/.test(String(node.label || "")) && !["function", "method", "constructor"].includes(String(node.symbol_kind || "").toLowerCase())) continue;
    if (!ranked.has(id)) {
      ranked.set(id, 4);
      orphans.add(id);
    }
  }
  const all = [...ranked.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const positive = all.filter(([id]) => !orphans.has(id));
  const orphan = all.filter(([id]) => orphans.has(id));
  const reserve = orphan.length ? Math.min(8, Math.ceil(limit / 4), limit) : 0;
  const selected = positive.slice(0, Math.max(0, limit - reserve));
  selected.push(...orphan.slice(0, reserve));
  if (selected.length < limit) {
    const selectedIds = new Set(selected.map(([id]) => id));
    selected.push(...all.filter(([id]) => !selectedIds.has(id)).slice(0, limit - selected.length));
  }
  return {
    targets: selected.map(([id]) => byId.get(id)),
    total: all.length,
    orphanIds: new Set(orphan.map(([id]) => id)),
  };
}

function baseOverlay(graph, state, extra = {}) {
  return {
    precisionOverlayV: PRECISION_OVERLAY_V,
    baseGraphRevision: String(graph.graphRevision || ""),
    graphBuildMode: graphMode(graph),
    graphBuildScope: graphScope(graph),
    precisionMode: precisionMode(graph),
    providerContract: providerContractFor(graph),
    graphContract: graphContractFor(graph),
    state,
    engines: [],
    coverage: {candidates: 0, selected: 0, queried: 0, references: 0, unclassifiedReferences: 0, verifiedEdges: 0, truncated: false},
    links: [],
    referenceEvidence: [],
    noReferenceSymbols: [],
    ...extra,
  };
}

export function writePrecisionOverlay(graphPath, overlay) {
  atomicWriteFileSync(precisionPathForGraph(graphPath), JSON.stringify(overlay), "utf8");
  return overlay;
}

const SAFE_INVALIDATION_REASON = "repository changed while semantic precision was running";

// The graph builder calls this after its post-LSP repository snapshot check. Never preserve exact
// edges or no-reference proofs from a run that overlapped a source/configuration change.
export function invalidatePrecisionOverlay(graphPath, graph, reason = SAFE_INVALIDATION_REASON) {
  if (!graphPath || !graph) throw new Error("precision invalidation requires graphPath and graph");
  const previous = readPrecisionOverlay(graphPath, graph);
  const safeReason = typeof reason === "string"
    && reason.length > 0 && reason.length <= 160
    && /^[A-Za-z0-9 _.,()-]+$/.test(reason)
    ? reason
    : SAFE_INVALIDATION_REASON;
  const engines = (Array.isArray(previous?.engines) && previous.engines.length
    ? previous.engines
    : [{provider: "typescript-language-server", version: null, language: "typescript/javascript", capability: "textDocument/references"}])
    .map((engine) => ({...engine, status: "PARTIAL"}));
  return writePrecisionOverlay(graphPath, baseOverlay(graph, "PARTIAL", {
    ...(previous?.request ? {request: previous.request} : {}),
    reason: safeReason,
    engines,
    coverage: {candidates: 0, selected: 0, queried: 0, references: 0, unclassifiedReferences: 0, verifiedEdges: 0, truncated: true},
    links: [],
    referenceEvidence: [],
    noReferenceSymbols: [],
  }));
}

class PrecisionBudgetError extends Error {
  constructor(message = "semantic precision deadline reached") {
    super(message);
    this.name = "PrecisionBudgetError";
  }
}

class PrecisionLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrecisionLimitError";
  }
}

class PrecisionStaleGraphError extends Error {
  constructor() {
    super("repository content did not match the graph snapshot");
    this.name = "PrecisionStaleGraphError";
  }
}

class PrecisionStaleSemanticInputsError extends Error {
  constructor() {
    super("TypeScript project inputs changed while semantic precision was running");
    this.name = "PrecisionStaleSemanticInputsError";
  }
}

function graphJavaScriptUniverse(graph) {
  const files = [...new Set((graph.nodes || [])
    .filter((node) => {
      const id = String(node?.id || "");
      const file = norm(node?.source_file || id);
      return id === file && JS_TS_FILE.test(file);
    })
    .map((node) => norm(node.source_file || node.id)))].sort();
  const hashed = Object.keys(graph.fileHashes || {}).map(norm).filter((file) => JS_TS_FILE.test(file)).sort();
  const fileSet = new Set(files);
  const complete = graphMode(graph) === "full" && !graphScope(graph)
    && files.length === hashed.length && hashed.every((file) => fileSet.has(file));
  return {files, complete};
}

// Synchronous and bounded so callers can reject a persisted COMPLETE overlay before taking an
// auto-refresh/probe shortcut. The digest covers applicable repo-contained config chains,
// configured project paths, and the content of configured files omitted from the graph.
export function precisionSemanticInputs(repoRoot, graph, options = {}) {
  const universe = graphJavaScriptUniverse(graph);
  if (!universe.files.length) {
    return {safe: false, reason: "NO_JAVASCRIPT_TYPESCRIPT_INPUTS", fingerprint: null, universe};
  }
  return {...typeScriptProjectSafety(repoRoot, universe.files, options), universe};
}

export function precisionSemanticInputsMatch(overlay, repoRoot, graph) {
  const current = precisionSemanticInputs(repoRoot, graph);
  return current.safe === true
    && typeof current.fingerprint === "string"
    && current.fingerprint.length > 0
    && String(overlay?.semanticInputFingerprint || "") === current.fingerprint;
}

function publicSemanticSafetyReason(reason) {
  return reason === "CONFIGURED_TSSERVER_PLUGINS"
    ? "configured TypeScript language-service plugins are not allowed"
    : "TypeScript project configuration could not be verified safely";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? Math.floor(number) : fallback));
}

export async function buildLspPrecisionOverlay({
  repoRoot,
  graph,
  graphPath,
  mode = "lsp",
  maxSymbols = Number(process.env.WEAVATRIX_PRECISION_MAX_SYMBOLS) || 32,
  maxReferences = Number(process.env.WEAVATRIX_PRECISION_MAX_REFERENCES) || 2_048,
  maxLinks = Number(process.env.WEAVATRIX_PRECISION_MAX_LINKS) || 2_048,
  timeoutMs = Number(process.env.WEAVATRIX_PRECISION_TIMEOUT_MS) || 45_000,
  clientFactory,
} = {}) {
  if (!graph || !repoRoot) throw new Error("precision overlay requires repoRoot and graph");
  const boundedMax = boundedInteger(maxSymbols, 32, 1, 64);
  const boundedReferences = boundedInteger(maxReferences, 2_048, 1, 16_384);
  const boundedLinks = boundedInteger(maxLinks, 2_048, 1, 16_384);
  const boundedTimeout = boundedInteger(timeoutMs, 45_000, 100, 60_000);
  const request = {maxSymbols: boundedMax, maxReferences: boundedReferences, maxLinks: boundedLinks};
  if (mode === "off") {
    const overlay = baseOverlay(graph, "OFF", {request, reason: "precision disabled by request"});
    return graphPath ? writePrecisionOverlay(graphPath, overlay) : overlay;
  }
  // Configuration discovery is part of the same global budget as the provider. Its bounded
  // directory host also receives this absolute deadline, so ignored include trees cannot consume
  // unlimited synchronous work before the LSP timer starts.
  const deadline = Date.now() + boundedTimeout;
  const universe = graphJavaScriptUniverse(graph);
  if (!universe.files.length) {
    const overlay = baseOverlay(graph, "UNAVAILABLE", {
      request,
      reason: "semantic precision currently supports JavaScript and TypeScript repositories",
    });
    return graphPath ? writePrecisionOverlay(graphPath, overlay) : overlay;
  }
  const semanticInputs = precisionSemanticInputs(repoRoot, graph, {deadline});
  if (!semanticInputs.safe) {
    const overlay = baseOverlay(graph, "UNAVAILABLE", {
      request,
      reason: publicSemanticSafetyReason(semanticInputs.reason),
      engines: [{
        provider: "typescript-language-server",
        version: null,
        language: "typescript/javascript",
        capability: "textDocument/references",
        status: "UNAVAILABLE",
      }],
    });
    return graphPath ? writePrecisionOverlay(graphPath, overlay) : overlay;
  }
  if (graphPath) {
    const cached = readPrecisionOverlay(graphPath, graph);
    if (cached?.state === "COMPLETE"
      && precisionOverlayMatches(cached, graph, {request})
      && cached.semanticInputFingerprint === semanticInputs.fingerprint) return cached;
  }
  const eligible = eligibleTargets(graph, boundedMax);
  const targets = eligible.targets;
  if (!targets.length) {
    const overlay = baseOverlay(graph, "COMPLETE", {
      request,
      semanticInputFingerprint: semanticInputs.fingerprint,
      reason: "no eligible JavaScript/TypeScript semantic targets",
    });
    return graphPath ? writePrecisionOverlay(graphPath, overlay) : overlay;
  }

  const makeClient = clientFactory || createTypeScriptLspClient;
  let client;
  const links = [];
  const seen = new Set();
  const evidenceSeen = new Set();
  const index = symbolIndex(graph);
  let queried = 0;
  let references = 0;
  let unclassifiedReferences = 0;
  let errors = 0;
  let truncated = eligible.total > boundedMax;
  const noReferenceSymbols = [];
  const referenceEvidence = [];
  const opened = new Set();
  const openedTexts = new Map();
  const classificationTexts = new Map();
  let classificationBytes = 0;
  let openedBytes = 0;
  let fullUniverseOpened = false;
  let stop = false;
  const nodesById = new Map((graph.nodes || []).map((node) => [String(node.id), node]));
  const boundary = createRepoBoundary(repoRoot);
  const remaining = () => deadline - Date.now();
  const ensureBudget = () => {
    if (remaining() <= 0) throw new PrecisionBudgetError();
  };
  const awaitWithBudget = (operation) => {
    ensureBudget();
    const wait = remaining();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new PrecisionBudgetError()), wait);
      Promise.resolve().then(operation).then(
        (value) => { clearTimeout(timer); resolvePromise(value); },
        (error) => { clearTimeout(timer); rejectPromise(error); },
      );
    });
  };
  const coverage = (verifiedEdges = links.length) => ({
    candidates: eligible.total,
    selected: targets.length,
    queried,
    references,
    unclassifiedReferences,
    verifiedEdges,
    truncated,
  });
  try {
    client = await awaitWithBudget(() => makeClient({repoRoot, timeoutMs: Math.max(100, remaining())}));
    const verifiedSource = (relPath, maxBytes = 4 * 1024 * 1024) => {
      const file = norm(relPath);
      const expectedHash = graph.fileHashes?.[file];
      if (!file || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ""))) throw new PrecisionStaleGraphError();
      const resolvedFile = boundary.resolve(file);
      if (!resolvedFile.ok) throw new PrecisionStaleGraphError();
      let size;
      try { size = statSync(resolvedFile.path).size; } catch { throw new PrecisionStaleGraphError(); }
      if (size > maxBytes) throw new PrecisionLimitError("precision source-read budget reached");
      let body;
      try { body = readFileSync(resolvedFile.path); } catch { throw new PrecisionStaleGraphError(); }
      if (body.byteLength > maxBytes) throw new PrecisionLimitError("precision source-read budget reached");
      if (createHash("sha256").update(body).digest("hex") !== expectedHash) throw new PrecisionStaleGraphError();
      return {file, body, bytes: body.byteLength, text: body.toString("utf8")};
    };
    const ensureOpen = async (relPath) => {
      const file = norm(relPath);
      if (!file || opened.has(file)) return;
      ensureBudget();
      if (opened.size >= 96) throw new PrecisionLimitError("precision open-document limit reached");
      // Re-read and re-hash here even when classification cached the file earlier: didOpen must
      // always be immediately guarded by the graph snapshot hash.
      const {bytes, text} = verifiedSource(file, Math.min(4 * 1024 * 1024, 32 * 1024 * 1024 - openedBytes));
      if (bytes > 4 * 1024 * 1024) throw new PrecisionLimitError("precision document exceeds 4 MiB limit");
      if (openedBytes + bytes > 32 * 1024 * 1024) throw new PrecisionLimitError("precision source-transfer budget reached");
      await awaitWithBudget(() => client.openDocument(file, text));
      opened.add(file);
      openedTexts.set(file, text);
      openedBytes += bytes;
    };

    const sourceForClassification = (relPath) => {
      const file = norm(relPath);
      if (openedTexts.has(file)) return openedTexts.get(file);
      if (classificationTexts.has(file)) return classificationTexts.get(file);
      if (classificationTexts.size >= 96) return null;
      let source;
      try {
        source = verifiedSource(file, Math.min(4 * 1024 * 1024, 32 * 1024 * 1024 - classificationBytes));
      } catch (error) {
        if (error instanceof PrecisionLimitError) return null;
        throw error;
      }
      classificationTexts.set(file, source.text);
      classificationBytes += source.bytes;
      return source.text;
    };

    const ensureFullUniverse = async () => {
      if (fullUniverseOpened) return true;
      if (!universe.complete) return false;
      const additional = universe.files.filter((file) => !opened.has(file));
      if (opened.size + additional.length > 96) {
        truncated = true;
        return false;
      }
      let projectedBytes = openedBytes;
      for (const file of additional) {
        ensureBudget();
        if (!/^[a-f0-9]{64}$/i.test(String(graph.fileHashes?.[file] || ""))) throw new PrecisionStaleGraphError();
        const resolvedFile = boundary.resolve(file);
        if (!resolvedFile.ok) throw new PrecisionStaleGraphError();
        let bytes;
        try { bytes = statSync(resolvedFile.path).size; } catch { throw new PrecisionStaleGraphError(); }
        if (bytes > 4 * 1024 * 1024 || projectedBytes + bytes > 32 * 1024 * 1024) {
          truncated = true;
          return false;
        }
        projectedBytes += bytes;
      }
      for (const file of additional) await ensureOpen(file);
      fullUniverseOpened = universe.files.every((file) => opened.has(file));
      return fullUniverseOpened;
    };

    const requestReferences = (relPath, position) => awaitWithBudget(
      () => client.references(relPath, position, false, Math.max(1, remaining())),
    );

    for (const target of targets) {
      const relPath = norm(target.source_file);
      let locations;
      try {
        await ensureOpen(relPath);
        // In inferred JavaScript projects the language server only knows opened roots. Open the
        // bounded static callers of this target so exact validation works without executing repo
        // configuration or pretending the whole unconfigured workspace was indexed.
        const supportFiles = [];
        for (const link of graph.links || []) {
          if (endpoint(link.target) !== String(target.id) || isStructuralRelation(link.relation)) continue;
          const sourceId = endpoint(link.source);
          const sourceFile = norm(nodesById.get(sourceId)?.source_file || (sourceId.includes("#") ? sourceId.slice(0, sourceId.indexOf("#")) : sourceId));
          if (sourceFile && JS_TS_FILE.test(sourceFile) && sourceFile !== relPath && !supportFiles.includes(sourceFile)) supportFiles.push(sourceFile);
          if (supportFiles.length >= 12) break;
        }
        for (const file of supportFiles) await ensureOpen(file);
        if (universe.complete && universe.files.every((file) => opened.has(file))) fullUniverseOpened = true;
        locations = await requestReferences(relPath, target.selection_start);
        if (!Array.isArray(locations)) throw new Error("language server returned an invalid references result");
        queried++;
        if (locations.length === 0) {
          ensureBudget();
          const configRel = semanticInputs.fileConfigs?.[relPath];
          const project = configRel ? semanticInputs.projects?.[configRel] : null;
          const configuredFiles = [...new Set((project?.projectFiles || [])
            .map(norm).filter((file) => JS_TS_FILE.test(file)))].sort();
          const projectFiles = new Set(configuredFiles);
          const projectExactlyCoversUniverse = universe.complete
            && configuredFiles.length === universe.files.length
            && universe.files.every((file) => projectFiles.has(file));
          ensureBudget();
          if (configRel && projectFiles.has(relPath) && projectExactlyCoversUniverse) {
            const alreadyComplete = fullUniverseOpened;
            if (alreadyComplete || await ensureFullUniverse()) {
              // Opening the complete graph universe can move files from an inferred project into
              // the configured one. Re-query the first empty response after that transition.
              if (!alreadyComplete) locations = await requestReferences(relPath, target.selection_start);
              if (!Array.isArray(locations)) throw new Error("language server returned an invalid references result");
              if (locations.length === 0) noReferenceSymbols.push(String(target.id));
            }
          }
        }
      } catch (error) {
        if (error instanceof PrecisionStaleGraphError) throw error;
        if (error instanceof PrecisionBudgetError || error instanceof PrecisionLimitError || remaining() <= 0) {
          truncated = true;
          stop = true;
          break;
        }
        errors++;
        continue;
      }
      for (const location of locations) {
        if (remaining() <= 0) {
          truncated = true;
          stop = true;
          break;
        }
        if (references >= boundedReferences) {
          truncated = true;
          stop = true;
          break;
        }
        references++;
        const file = repoFileFromLocation(repoRoot, location);
        const start = locationStart(location);
        if (!file || !start || !Number.isInteger(start.line) || !Number.isInteger(start.character)) continue;
        const source = sourceAt(index, file, start);
        if (!source || source === String(target.id)) continue;
        const targetId = String(target.id);
        const exactLine = start.line + 1;
        const exactCharacter = start.character;
        const relation = "references";
        const line = exactLine;
        const targetFile = norm(target.source_file);
        const moduleDependency = source === file && targetFile
          ? (graph.links || []).find((link) => endpoint(link.source) === file
            && endpoint(link.target) === targetFile
            && ["imports", "re_exports"].includes(String(link.relation || ""))
            && Number.isInteger(link.line) && link.line === exactLine)
          : null;
        const sourceText = sourceForClassification(file);
        let usage = sourceText == null
          ? "unknown"
          : classifyTypeScriptReferenceUsage(file, sourceText, start);
        if (usage === "unknown" && moduleDependency?.typeOnly === true) usage = "type";
        if (usage === "unknown" && moduleDependency?.compileOnly === true) usage = "compile";
        if (usage === "unknown") {
          const evidenceKey = `${source}\0${targetId}\0${line}\0${exactCharacter}`;
          if (!evidenceSeen.has(evidenceKey)) {
            if (referenceEvidence.length >= boundedLinks) {
              truncated = true;
              stop = true;
              break;
            }
            evidenceSeen.add(evidenceKey);
            unclassifiedReferences++;
            referenceEvidence.push({
              source,
              target: targetId,
              line,
              character: exactCharacter,
              classification: "unknown",
              provider: "typescript-language-server",
            });
          }
          continue;
        }
        const key = `${source}\0${relation}\0${targetId}\0${line}\0${exactCharacter}`;
        if (seen.has(key)) continue;
        if (links.length >= boundedLinks) {
          truncated = true;
          stop = true;
          break;
        }
        seen.add(key);
        links.push({
          source,
          target: targetId,
          relation,
          line,
          character: exactCharacter,
          ...(Number.isInteger(location?.range?.end?.line) ? {endLine: location.range.end.line + 1} : {}),
          ...(Number.isInteger(location?.range?.end?.character) ? {endCharacter: location.range.end.character} : {}),
          provenance: "EXACT_LSP",
          provider: "typescript-language-server",
          ...(usage === "type" || moduleDependency?.typeOnly === true ? {typeOnly: true} : {}),
          ...(usage === "compile" || moduleDependency?.compileOnly === true ? {compileOnly: true} : {}),
        });
      }
      if (remaining() <= 0) {
        truncated = true;
        stop = true;
      }
      if (stop) break;
    }
    ensureBudget();
    const semanticInputsAfter = precisionSemanticInputs(repoRoot, graph, {deadline});
    ensureBudget();
    if (!semanticInputsAfter.safe || semanticInputsAfter.fingerprint !== semanticInputs.fingerprint) {
      throw new PrecisionStaleSemanticInputsError();
    }
    const state = errors || truncated || unclassifiedReferences ? "PARTIAL" : "COMPLETE";
    const overlay = baseOverlay(graph, state, {
      request,
      engines: [{
        provider: client.provider || "typescript-language-server",
        version: client.version || null,
        typescriptVersion: client.typescriptVersion || null,
        typescriptSource: client.typescriptSource || null,
        language: "typescript/javascript",
        capability: "textDocument/references",
        status: state,
      }],
      semanticInputFingerprint: semanticInputs.fingerprint,
      coverage: coverage(),
      links,
      referenceEvidence,
      noReferenceSymbols,
      ...(errors ? {reason: `${errors} semantic request(s) failed or were refused`}
        : truncated ? {reason: "semantic precision stopped at a configured safety limit"}
          : unclassifiedReferences ? {reason: "some exact references could not be classified as runtime or type-only"} : {}),
    });
    return graphPath ? writePrecisionOverlay(graphPath, overlay) : overlay;
  } catch (error) {
    const stale = error instanceof PrecisionStaleGraphError;
    const semanticInputsChanged = error instanceof PrecisionStaleSemanticInputsError;
    const deadlineReached = error instanceof PrecisionBudgetError || remaining() <= 0;
    const state = stale || semanticInputsChanged || deadlineReached ? "PARTIAL" : "UNAVAILABLE";
    const overlay = baseOverlay(graph, state, {
      request,
      // Provider stderr and discovery errors can contain host paths. Persist a bounded status, never
      // raw diagnostics, command lines, environment values, or absolute install/repository paths.
      reason: stale
        ? "repository content no longer matched the graph snapshot"
        : semanticInputsChanged ? "TypeScript project inputs changed while semantic precision was running"
        : deadlineReached ? "semantic precision stopped at its global deadline"
          : error?.name === "LspTimeoutError" ? "bundled TypeScript language server timed out"
            : "bundled TypeScript language server was unavailable",
      engines: [{provider: "typescript-language-server", version: null, language: "typescript/javascript", capability: "textDocument/references", status: state}],
      coverage: {
        candidates: eligible.total,
        selected: targets.length,
        queried: stale || semanticInputsChanged ? 0 : queried,
        references: stale || semanticInputsChanged ? 0 : references,
        unclassifiedReferences: stale || semanticInputsChanged ? 0 : unclassifiedReferences,
        verifiedEdges: 0,
        truncated: truncated || stale || semanticInputsChanged || deadlineReached,
      },
      links: [],
      noReferenceSymbols: [],
    });
    return graphPath ? writePrecisionOverlay(graphPath, overlay) : overlay;
  } finally {
    if (client) {
      const closeBudget = Math.min(2_000, Math.max(0, remaining()));
      if (closeBudget > 0 && client.close) {
        try { await awaitWithBudget(() => client.close(closeBudget)); }
        catch { client.kill?.(); }
      } else {
        client.kill?.();
      }
    }
  }
}
