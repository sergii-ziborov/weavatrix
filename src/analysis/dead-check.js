// Portable, language-agnostic DEAD-code checker. A symbol is DEAD when it has NO inbound graph edge (nothing
// calls/imports/references/inherits it) AND its bare name appears NOWHERE in the repo outside its own file.
// A file is DEAD when nothing imports it, it isn't an entry point, and all its symbols are dead.
//
// Pure core `computeDead(graph, sources)` (sources = Map<fileRel, text>) works on any graph-builder-schema graph
// and is fully testable with no filesystem. It only needs {nodes, links} + source text. See [[graph-builder-internalization]].
import { posix } from "node:path";
import { isStructuralRelation } from "../graph/relations.js";
import { createPathClassifier, hasPathClass } from "../path-classification.js";

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const bareName = (label) => String(label || "").replace(/\s*\(.*$/, "").replace(/[()]/g, "").trim();
// Ignore comment-only lexical mentions, which are documentation rather than callers. Keep strings on
// purpose: registries/reflection often address a live symbol by name, and static liveness must stay
// conservative there. This only strips comments that start a logical line, avoiding a language parser
// guess around inline comment markers, regex literals, or URLs.
const lexicalEvidenceText = (value) => {
  let inBlockComment = false;
  return String(value || "").split(/\r?\n/).map((line) => {
    let rest = line;
    while (true) {
      if (inBlockComment) {
        const end = rest.indexOf("*/");
        if (end < 0) return "";
        inBlockComment = false;
        rest = rest.slice(end + 2);
      }
      const trimmed = rest.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) return "";
      if (!trimmed.startsWith("/*")) return rest;
      inBlockComment = true;
      rest = trimmed.slice(2);
    }
  }).join("\n");
};
// entry surfaces are never dead even with no inbound edge (framework/CLI/HTTP enter them externally).
// Exported for internal-audit.js (reachability entry set) — keep the two in lockstep.
export const ENTRY_FILE = /(^|[\\/])(index|main|app|server|cli|cmd|bootstrap|entry|run|__main__|manage|wsgi|asgi|setup|conftest)\.[a-z0-9]+$|(^|[\\/])(bin|cmd)[\\/]|(^|[\\/])main\.go$/i;
const defaultPathClassifier = createPathClassifier(null);
const isTestFile = (file) => hasPathClass(defaultPathClassifier.explain(file), "test", "e2e");

// Framework-owned entry modules are invoked by convention rather than a source import. Keep this narrow:
// these are Next.js App/Pages Router surfaces and framework metadata files, not every file under `app/`.
const NEXT_ENTRY_FILE = /(^|\/)(?:src\/)?app\/(?:.*\/)?(?:page|layout|template|loading|error|global-error|not-found|default|route|robots|sitemap|manifest|opengraph-image|twitter-image|icon|apple-icon)\.[cm]?[jt]sx?$|(^|\/)(?:src\/)?pages\/(?!.*\/(?:components?|lib|utils?)\/).+\.[cm]?[jt]sx?$|(^|\/)(?:middleware|instrumentation)\.[cm]?[jt]s$/i;
const RUST_ENTRY_FILE = /(^|\/)(?:build\.rs|src\/(?:lib|main)\.rs)$/i;
export const isFrameworkEntryFile = (file) => {
  const normalized = String(file || "").replace(/\\/g, "/");
  return NEXT_ENTRY_FILE.test(normalized) || RUST_ENTRY_FILE.test(normalized);
};

const lineOfNode = (n) => {
  const m = /@(\d+)$/.exec(String(n.id || "")) || /L(\d+)/.exec(String(n.source_location || ""));
  return m ? Number(m[1]) : 0;
};

// Older graphs marked every method of an exported class as exported. Verify that an `exported` node is
// actually a module-surface declaration before reporting it. New graphs expose symbol_kind/member_of and
// already keep members unexported, but the source check preserves correctness for cached v0.1.2 graphs.
function hasModuleExport(source, node, name) {
  if (node.member_of || node.symbol_kind === "method") return false;
  const lines = String(source || "").split(/\r?\n/);
  const line = lines[Math.max(0, lineOfNode(node) - 1)] || "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const direct = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:(?:declare|abstract|async)\\s+)*(?:function|class|const|let|var|enum|interface|type|namespace)\\s+${escaped}\\b`);
  if (direct.test(line) || direct.test(String(source || ""))) return true;
  const exportDefault = new RegExp(`\\bexport\\s+default\\s+${escaped}\\b`);
  if (exportDefault.test(String(source || ""))) return true;
  // `export { local }`, `export { local as publicName }` and CommonJS explicit exports.
  const exportList = new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "s");
  const commonJs = new RegExp(`(?:module\\.exports\\s*=\\s*\\{[^}]*\\b${escaped}\\b|(?:module\\.exports|exports)\\.${escaped}\\s*=)`, "s");
  return exportList.test(String(source || "")) || commonJs.test(String(source || ""));
}

function namespaceConsumedFiles(sources, graph) {
  const files = new Set(sources.keys());
  const consumed = new Set();
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
  const resolve = (from, spec) => {
    if (!spec.startsWith(".")) return "";
    const base = posix.normalize(posix.join(posix.dirname(from.replace(/\\/g, "/")), spec));
    for (const ext of extensions) {
      const p = `${base}${ext}`;
      if (files.has(p)) return p;
    }
    for (const ext of extensions.slice(1)) {
      const p = `${base}/index${ext}`;
      if (files.has(p)) return p;
    }
    return "";
  };
  for (const [file, textValue] of sources) {
    const text = String(textValue || "");
    const patterns = [
      /\bimport\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s*(["'])([^"']+)\1/g,
      /\bexport\s+\*\s+from\s*(["'])([^"']+)\1/g,
      /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\(\s*(["'])([^"']+)\1\s*\)/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text))) {
        const target = resolve(file, m[2]);
        if (target) consumed.add(target);
      }
    }
  }
  // New graphs retain the exact specifier on file import edges, which also resolves namespace imports
  // expressed through tsconfig aliases (the relative-path fallback above intentionally cannot guess those).
  for (const link of graph.links || []) {
    if (link.relation !== "imports" && link.relation !== "re_exports") continue;
    const from = String(link.source?.id || link.source || ""), target = String(link.target?.id || link.target || "");
    if (!link.specifier || from.includes("#") || target.includes("#") || !sources.has(from)) continue;
    const spec = String(link.specifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const text = String(sources.get(from) || "");
    if (new RegExp(`(?:import\\s+\\*\\s+as\\s+[A-Za-z_$][\\w$]*\\s+from|export\\s+\\*\\s+from)\\s*["']${spec}["']`).test(text)) consumed.add(target);
  }
  return consumed;
}

export function computeDead(graph, sources, { entrySet = new Set() } = {}) {
  const nodes = graph.nodes || [], links = graph.links || [];
  const ep = (v) => (v && typeof v === "object" ? v.id : v);
  const inbound = new Set();
  const inboundSources = new Map();
  const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
  for (const l of links) if (!isStructuralRelation(l.relation)) {
    const target = String(ep(l.target));
    const source = String(ep(l.source));
    inbound.add(target);
    const values = inboundSources.get(target) || [];
    values.push(source);
    inboundSources.set(target, values);
  }

  // whole-repo identifier frequency: a symbol whose name appears MORE than once total (its definition + at least
  // one use, same-file OR cross-file) is referenced. Errs toward "alive" (common-named symbols never flagged).
  const globalFreq = new Map();
  for (const [, text] of sources) for (const m of lexicalEvidenceText(text).matchAll(IDENT_RE)) { const n = m[0]; globalFreq.set(n, (globalFreq.get(n) || 0) + 1); }

  const symById = new Map();
  const symsByFile = new Map();
  for (const n of nodes) {
    if (!String(n.id).includes("#")) continue;
    symById.set(n.id, n);
    (symsByFile.get(n.source_file) || symsByFile.set(n.source_file, []).get(n.source_file)).push(n);
  }

  const symbolNames = new Set([...symById.values()].map((node) => bareName(node.label)).filter(Boolean));
  const occurrenceFiles = new Map();
  const occurrenceCounts = new Map();
  for (const [file, text] of sources) for (const match of lexicalEvidenceText(text).matchAll(IDENT_RE)) {
    const name = match[0];
    if (!symbolNames.has(name)) continue;
    const files = occurrenceFiles.get(name) || new Set();
    files.add(file);
    occurrenceFiles.set(name, files);
    const counts = occurrenceCounts.get(name) || new Map();
    counts.set(file, (counts.get(file) || 0) + 1);
    occurrenceCounts.set(name, counts);
  }

  const declarationCounts = new Map();
  for (const node of symById.values()) {
    const name = bareName(node.label);
    if (!name) continue;
    const key = `${node.source_file}\0${name}`;
    declarationCounts.set(key, (declarationCounts.get(key) || 0) + 1);
  }
  const exactReferenceIds = new Set(graph.precisionReferenceSymbols || []);
  const exactProductionReferenceIds = new Set(graph.precisionProductionReferenceSymbols || []);
  const exactTestReferenceIds = new Set(graph.precisionTestReferenceSymbols || []);

  // decorated defs (@app.route/@app.event/@pytest.fixture…) are entered by the framework: trust the
  // builder's flag when present, else walk the source line(s) above the definition (graph-builder graphs).
  const lineCache = new Map();
  const linesOf = (f) => { let l = lineCache.get(f); if (!l) { l = String(sources.get(f) || "").split(/\r?\n/); lineCache.set(f, l); } return l; };
  const symLine = (n) => { const m = /@(\d+)$/.exec(String(n.id)) || /L(\d+)/.exec(String(n.source_location || "")); return m ? Number(m[1]) : 0; };
  const isDecorated = (n) => {
    if (n.decorated) return true;
    const ln = symLine(n);
    if (!ln) return false;
    const lines = linesOf(n.source_file);
    for (let i = ln - 2; i >= 0 && i >= ln - 6; i--) {
      const t = (lines[i] || "").trim();
      if (t.startsWith("@")) return true;
      if (t === "" || t.startsWith("#")) continue;
      break;
    }
    return false;
  };

  const isReferenced = (n) => {
    if (inbound.has(n.id)) return true;                          // a real graph edge targets it
    if (exactReferenceIds.has(String(n.id))) return true;        // revision-bound point-query evidence found a caller
    const name = bareName(n.label);
    if (!name || !/^[A-Za-z_$]/.test(name)) return true;         // selectors/odd labels → don't flag
    if (/^__\w+__$/.test(name)) return true;                     // dunders are invoked implicitly (with/str/==/iter…), never spelled
    if ((globalFreq.get(name) || 0) > 1) return true;            // name appears beyond its single definition
    return isDecorated(n);                                       // framework-registered via decorator
  };

  const deadSymbols = [];
  for (const n of symById.values()) {
    if (isReferenced(n)) continue;
    // test_surface: extractor-proven test-only symbols (Rust #[cfg(test)]) live in production paths.
    const test = isTestFile(n.source_file) || n.test_surface === true;
    deadSymbols.push({ id: n.id, file: n.source_file, label: n.label, test, reason: "no inbound edge and name unreferenced outside its file" });
  }
  const deadSet = new Set(deadSymbols.map((s) => s.id));

  // A production declaration consumed only by tests is live to the raw graph but dead to production.
  // Keep it in a separate review class: this is useful evidence, never an automatic delete verdict.
  const testOnlySymbols = [];
  const consumerFileOf = (id) => nodesById.get(id)?.source_file || (id.includes("#") ? id.split("#")[0] : id);
  const isTestConsumer = (id) => nodesById.get(id)?.test_surface === true || isTestFile(consumerFileOf(id));
  for (const n of symById.values()) {
    if (deadSet.has(n.id) || isTestFile(n.source_file) || n.test_surface === true || isDecorated(n)) continue;
    const sourcesForSymbol = inboundSources.get(String(n.id)) || [];
    const hasTestInbound = sourcesForSymbol.some(isTestConsumer);
    const hasProductionInbound = sourcesForSymbol.some((id) => consumerFileOf(id) && !isTestConsumer(id));
    const name = bareName(n.label);
    const occurrenceSet = occurrenceFiles.get(name) || new Set();
    const externalOccurrences = [...occurrenceSet].filter((file) => file !== n.source_file);
    const localOccurrences = occurrenceCounts.get(name)?.get(n.source_file) || 0;
    const localDeclarations = declarationCounts.get(`${n.source_file}\0${name}`) || 0;
    const hasLocalProductionUse = localOccurrences > localDeclarations;
    const lexicalTestOnly = externalOccurrences.length > 0 && externalOccurrences.every((file) => isTestFile(file));
    const hasExactProductionInbound = exactProductionReferenceIds.has(String(n.id));
    const hasExactTestInbound = exactTestReferenceIds.has(String(n.id));
    if (hasProductionInbound || hasExactProductionInbound || hasLocalProductionUse
      || (!hasTestInbound && !hasExactTestInbound && !lexicalTestOnly)) continue;
    testOnlySymbols.push({
      id: n.id,
      file: n.source_file,
      label: n.label,
      test: false,
      reason: "referenced only from test/e2e code; no production consumer was found",
      testConsumerFiles: [...new Set(sourcesForSymbol.filter(isTestConsumer).map(consumerFileOf).filter(Boolean))].sort(),
      evidence: hasTestInbound ? "graph" : hasExactTestInbound ? "exact-semantic" : "lexical",
      publicApi: n.exported === true || ["public", "protected"].includes(String(n.visibility || "").toLowerCase()),
    });
  }

  const deadFiles = [];
  for (const n of nodes) {
    if (String(n.id).includes("#")) continue;                   // file nodes only
    if (inbound.has(n.id) || ENTRY_FILE.test(n.source_file) || isFrameworkEntryFile(n.source_file) || entrySet.has(n.source_file)) continue;
    const syms = symsByFile.get(n.source_file) || [];
    if (syms.length && syms.every((s) => deadSet.has(s.id))) deadFiles.push({ file: n.source_file, reason: "not imported; all symbols unreferenced" });
  }

  return {
    deadSymbols,
    testOnlySymbols,
    deadFiles,
    referencedIds: [...symById.values()].filter(isReferenced).map((n) => n.id),
    stats: { symbols: symById.size, deadSymbols: deadSymbols.length, testOnlySymbols: testOnlySymbols.length, files: nodes.filter((n) => !String(n.id).includes("#")).length, deadFiles: deadFiles.length },
  };
}

// Export-scoped unused check (knip's "unused exports"): an EXPORTED symbol (P0's exported:true flag)
// with no inbound non-contains edge whose bare name occurs in NO file other than its own. Same-file-only
// usage means the symbol is alive but the export is not — still worth surfacing. Pure like computeDead.
// dynamicTargets = files reached via dynamic import() — their exports are consumed at runtime, skip them.
export function computeUnusedExports(graph, sources, { dynamicTargets = new Set(), entrySet = new Set() } = {}) {
  const nodes = graph.nodes || [], links = graph.links || [];
  const ep = (v) => (v && typeof v === "object" ? v.id : v);
  const inbound = new Set();
  for (const l of links) if (!isStructuralRelation(l.relation)) inbound.add(ep(l.target));

  const namespaceConsumed = namespaceConsumedFiles(sources, graph);
  const candidates = [];
  const wanted = new Set();
  for (const n of nodes) {
    if (!n.exported || !String(n.id).includes("#") || inbound.has(n.id)) continue;
    if (ENTRY_FILE.test(n.source_file) || isFrameworkEntryFile(n.source_file) || entrySet.has(n.source_file) || dynamicTargets.has(n.source_file) || namespaceConsumed.has(n.source_file)) continue;
    const nm = bareName(n.label);
    if (!nm || !/^[A-Za-z_$]/.test(nm)) continue;
    if (!hasModuleExport(sources.get(n.source_file), n, nm)) continue;
    candidates.push({ n, nm });
    wanted.add(nm);
  }
  if (!candidates.length) return [];

  const occursIn = new Map(); // name -> Set(files whose text contains it)
  for (const [file, text] of sources) {
    for (const m of String(text || "").matchAll(IDENT_RE)) {
      const w = m[0];
      if (!wanted.has(w)) continue;
      (occursIn.get(w) || occursIn.set(w, new Set()).get(w)).add(file);
    }
  }

  const out = [];
  for (const { n, nm } of candidates) {
    const occ = occursIn.get(nm);
    if (occ && [...occ].some((f) => f !== n.source_file)) continue; // referenced beyond its own file → alive
    out.push({ id: n.id, file: n.source_file, label: n.label, test: isTestFile(n.source_file), reason: "exported but never imported or referenced outside its own file" });
  }
  return out;
}
