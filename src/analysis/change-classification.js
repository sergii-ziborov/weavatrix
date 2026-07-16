// Symbol-aware git-diff classification for change_impact. This module only decides WHAT changed and
// which exact graph nodes are legitimate reverse-impact seeds; tools-impact owns traversal/formatting.
// Pure additions intentionally produce no seeds by default, preventing a new export in a busy API file
// from flooding the report with every legacy importer of that file.
import { spawnSync } from "node:child_process";
import { childProcessEnv } from "../child-env.js";
import { createPathClassifier, hasPathClass } from "../path-classification.js";

const DEFAULT_LIMITS = Object.freeze({
  maxDiffBytes: 2 * 1024 * 1024,
  maxFiles: 500,
  maxChangedLines: 20_000,
  maxLineLength: 4_000,
  maxSymbolsPerFile: 250,
  maxSeeds: 1_000,
});
const CLASS_RANK = Object.freeze({
  "metadata-only": 0,
  "test-only": 0,
  added: 1,
  "body-changed": 2,
  "signature-changed": 3,
  removed: 4,
  unknown: 5,
});
const VERDICT_RANK = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2 });
const STRUCTURAL_RELATIONS = new Set(["contains", "method"]);

const normalizePath = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const endpoint = (value) => String(value && typeof value === "object" ? value.id : value || "");
const lineNumber = (value) => Number((String(value || "").match(/(?:^L|@)(\d+)$/) || [])[1] || 0);
const bareLabel = (value) => String(value || "").replace(/\(.*$/, "").replace(/[^A-Za-z0-9_$].*$/, "").trim();
const boundedNumber = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));

function limitsOf(value = {}) {
  return {
    maxDiffBytes: boundedNumber(value.maxDiffBytes, DEFAULT_LIMITS.maxDiffBytes, 1_024, DEFAULT_LIMITS.maxDiffBytes),
    maxFiles: boundedNumber(value.maxFiles, DEFAULT_LIMITS.maxFiles, 1, DEFAULT_LIMITS.maxFiles),
    maxChangedLines: boundedNumber(value.maxChangedLines, DEFAULT_LIMITS.maxChangedLines, 10, DEFAULT_LIMITS.maxChangedLines),
    maxLineLength: boundedNumber(value.maxLineLength, DEFAULT_LIMITS.maxLineLength, 80, DEFAULT_LIMITS.maxLineLength),
    maxSymbolsPerFile: boundedNumber(value.maxSymbolsPerFile, DEFAULT_LIMITS.maxSymbolsPerFile, 1, DEFAULT_LIMITS.maxSymbolsPerFile),
    maxSeeds: boundedNumber(value.maxSeeds, DEFAULT_LIMITS.maxSeeds, 1, DEFAULT_LIMITS.maxSeeds),
  };
}

function decodeGitQuoted(value) {
  const input = String(value || "").trim();
  if (!input.startsWith('"')) return input.split("\t", 1)[0];
  try { return JSON.parse(input); } catch { /* Git also emits octal escapes, which JSON rejects. */ }
  const bytes = [];
  for (let index = 1; index < input.length - 1; index += 1) {
    const char = input[index];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = input[++index] || "";
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(input[index + 1] || "")) octal += input[++index];
      bytes.push(parseInt(octal, 8));
    } else {
      const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function diffPath(raw, prefix) {
  const decoded = decodeGitQuoted(raw);
  if (!decoded || decoded === "/dev/null") return null;
  return normalizePath(decoded.startsWith(`${prefix}/`) ? decoded.slice(2) : decoded);
}

function headerPaths(line) {
  const match = /^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/.exec(line);
  if (!match) return { oldPath: null, newPath: null };
  return { oldPath: diffPath(match[1], "a"), newPath: diffPath(match[2], "b") };
}

const emptyFile = (paths = {}) => ({
  oldPath: paths.oldPath || null,
  newPath: paths.newPath || null,
  newFile: false,
  deletedFile: false,
  renamed: false,
  binary: false,
  hunks: [],
  additions: [],
  removals: [],
});

// Parse ordinary unified output, expecting --unified=0 but safely accepting context lines too.
export function parseZeroContextDiff(diffText, options = {}) {
  const limits = limitsOf(options);
  const original = String(diffText ?? "");
  const byteLength = Buffer.byteLength(original);
  const oversized = byteLength > limits.maxDiffBytes;
  const text = oversized ? original.slice(0, limits.maxDiffBytes) : original;
  const files = [];
  let file = null;
  let hunk = null;
  let changedLines = 0;
  let truncated = oversized;
  const finish = () => {
    if (!file) return;
    if ((file.oldPath || file.newPath) && files.length < limits.maxFiles) files.push(file);
    else if (files.length >= limits.maxFiles) truncated = true;
    file = null;
    hunk = null;
  };
  const addChange = (kind, line, oldLine, newLine, mappedNewLine) => {
    changedLines++;
    if (changedLines > limits.maxChangedLines) { truncated = true; return; }
    const change = {
      kind,
      text: String(line).slice(0, limits.maxLineLength),
      ...(oldLine != null ? { oldLine } : {}),
      ...(newLine != null ? { newLine } : {}),
      mappedNewLine,
    };
    (kind === "added" ? file.additions : file.removals).push(change);
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      finish();
      file = emptyFile(headerPaths(line));
      continue;
    }
    if (!file && line.startsWith("--- ")) file = emptyFile();
    if (!file) continue;
    if (line.startsWith("new file mode ")) { file.newFile = true; continue; }
    if (line.startsWith("deleted file mode ")) { file.deletedFile = true; continue; }
    if (line.startsWith("rename from ")) { file.oldPath = normalizePath(decodeGitQuoted(line.slice(12))); file.renamed = true; continue; }
    if (line.startsWith("rename to ")) { file.newPath = normalizePath(decodeGitQuoted(line.slice(10))); file.renamed = true; continue; }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") { file.binary = true; continue; }
    if (!hunk && line.startsWith("--- ")) {
      file.oldPath = diffPath(line.slice(4), "a");
      if (!file.oldPath) file.newFile = true;
      continue;
    }
    if (!hunk && line.startsWith("+++ ")) {
      file.newPath = diffPath(line.slice(4), "b");
      if (!file.newPath) file.deletedFile = true;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      hunk = {
        oldStart: Number(match[1]), oldCount: match[2] == null ? 1 : Number(match[2]),
        newStart: Number(match[3]), newCount: match[4] == null ? 1 : Number(match[4]),
        oldCursor: Number(match[1]), newCursor: Number(match[3]),
      };
      file.hunks.push({ oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount });
      continue;
    }
    if (!hunk || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      addChange("added", line.slice(1), null, hunk.newCursor, hunk.newCursor);
      hunk.newCursor++;
    } else if (line.startsWith("-")) {
      addChange("removed", line.slice(1), hunk.oldCursor, null, hunk.newCursor);
      hunk.oldCursor++;
    } else {
      hunk.oldCursor++;
      hunk.newCursor++;
    }
  }
  finish();
  return {
    files,
    byteLength,
    changedLines: Math.min(changedLines, limits.maxChangedLines),
    truncated,
    oversized,
    limits,
  };
}

function graphIndex(graph, limits) {
  const byFile = new Map();
  for (const node of graph?.nodes || []) {
    const file = normalizePath(node?.source_file || (!String(node?.id || "").includes("#") ? node?.id : ""));
    if (!file) continue;
    if (!byFile.has(file)) byFile.set(file, { path: file, fileNodeId: null, symbols: [] });
    const record = byFile.get(file);
    if (!String(node.id).includes("#")) record.fileNodeId = String(node.id);
    else if (record.symbols.length < limits.maxSymbolsPerFile) {
      const start = lineNumber(node.source_location) || lineNumber(node.id);
      if (!start) continue;
      record.symbols.push({
        id: String(node.id),
        label: String(node.label || node.id),
        start,
        end: lineNumber(node.source_end),
        exported: node.exported === true,
        symbolKind: node.symbol_kind || null,
      });
    }
  }
  for (const record of byFile.values()) {
    record.symbols.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (let index = 0; index < record.symbols.length; index += 1) {
      const symbol = record.symbols[index];
      if (!symbol.end || symbol.end < symbol.start) {
        const next = record.symbols[index + 1]?.start;
        symbol.end = next ? Math.max(symbol.start, next - 1) : symbol.start + 400;
      }
      symbol.end = Math.min(symbol.end, symbol.start + 2_000);
    }
  }
  return byFile;
}

function isMetadataLine(text) {
  const value = String(text || "").trim();
  return !value || /^(?:\/\/|\/\*|\*|\*\/|#(?!include\b)|<!--|-->|"""|''')/.test(value);
}

function signatureText(text, symbol) {
  const value = String(text || "").trim();
  const name = bareLabel(symbol.label);
  const hasName = name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(value);
  return hasName && /\b(?:export|default|declare|abstract|async|function|class|interface|type|enum|const|let|var|def|func|fn|struct|trait|impl|public|private|protected|static)\b/.test(value);
}

function signaturePosition(change, symbol) {
  const candidates = change.kind === "removed" ? [change.mappedNewLine, change.oldLine] : [change.newLine];
  if (candidates.some((line) => line === symbol.start)) return true;
  const nearStart = candidates.some((line) => Number.isFinite(line) && line > symbol.start && line <= symbol.start + 4);
  if (!nearStart) return false;
  const value = String(change.text || "").trim();
  // Multiline TS/Python/Java/Go parameter/type clauses. Keep statement keywords out so an ordinary
  // first body line is not promoted to a public-contract change.
  if (/^(?:return|throw|yield|if|for|while|switch|match|const|let|var|this\.|self\.|[A-Za-z_$][\w$]*\s*=)/.test(value)) return false;
  return /^(?:[A-Za-z_$][\w$]*\??\s*:\s*[^;]+[,)]?|[A-Za-z_$][\w$<>,.?\[\] :*&]+\s+[A-Za-z_$][\w$]*\s*[,)]|[),:<>{}\[\]|&?]+)$/.test(value);
}

function moduleSignatureText(text) {
  return /^\s*(?:import\b|export\s+(?:\*|\{)|(?:const|let|var)\s+\w+\s*=\s*require\b|using\b|package\b|#include\b|mod\b|pub\s+use\b)/.test(String(text || ""));
}

function chooseSymbol(record, change) {
  if (!record?.symbols?.length) return null;
  const lines = change.kind === "removed"
    ? [...new Set([change.mappedNewLine, change.oldLine].filter((line) => Number.isFinite(line) && line > 0))]
    : [change.newLine];
  const candidates = [];
  for (const symbol of record.symbols) {
    if (!lines.some((line) => line >= symbol.start && line <= symbol.end)) continue;
    const label = bareLabel(symbol.label);
    const mentions = label && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(change.text);
    candidates.push({ symbol, mentions, span: symbol.end - symbol.start });
  }
  return candidates.sort((a, b) => Number(b.mentions) - Number(a.mentions) || a.span - b.span || a.symbol.id.localeCompare(b.symbol.id))[0]?.symbol || null;
}

function strongest(classes) {
  return [...classes].sort((a, b) => (CLASS_RANK[b] ?? 5) - (CLASS_RANK[a] ?? 5) || a.localeCompare(b))[0] || "metadata-only";
}

function uniqueSorted(values, limit) {
  const all = [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
  return { items: all.slice(0, limit), truncated: all.length > limit, total: all.length };
}

function analyzeParsedFile(parsed, indexed, { includeAddedSeeds }) {
  const path = parsed.newPath || parsed.oldPath || "(unknown)";
  const record = indexed.get(parsed.newPath) || indexed.get(parsed.oldPath) || null;
  const grouped = new Map();
  const unmapped = [];
  for (const change of [...parsed.additions, ...parsed.removals]) {
    const symbol = chooseSymbol(record, change);
    if (!symbol) { unmapped.push(change); continue; }
    if (!grouped.has(symbol.id)) grouped.set(symbol.id, { symbol, additions: [], removals: [] });
    grouped.get(symbol.id)[change.kind === "added" ? "additions" : "removals"].push(change);
  }

  const symbols = [];
  const seedIds = [];
  for (const group of [...grouped.values()].sort((a, b) => a.symbol.start - b.symbol.start || a.symbol.id.localeCompare(b.symbol.id))) {
    const addedCode = group.additions.filter((change) => !isMetadataLine(change.text));
    const removedCode = group.removals.filter((change) => !isMetadataLine(change.text));
    const addedDeclaration = addedCode.some((change) => signaturePosition(change, group.symbol) || signatureText(change.text, group.symbol));
    const removedDeclaration = removedCode.some((change) => signaturePosition(change, group.symbol) || signatureText(change.text, group.symbol));
    let classification;
    if (parsed.newFile || (addedDeclaration && !removedCode.length)) classification = "added";
    else if (parsed.deletedFile || (removedDeclaration && !addedCode.length)) classification = "removed";
    else if (addedDeclaration || removedDeclaration) classification = "signature-changed";
    else if (addedCode.length || removedCode.length) classification = "body-changed";
    else classification = "metadata-only";

    const reasons = {
      added: "new declaration; existing callers cannot depend on it yet",
      removed: "declaration removed; existing callers may break",
      "signature-changed": "declaration/signature line changed",
      "body-changed": "executable lines changed inside the symbol body",
      "metadata-only": "only comment/blank lines changed in this symbol",
    };
    const symbolSeeds = [];
    if (classification === "added") {
      if (includeAddedSeeds) symbolSeeds.push(group.symbol.id);
    } else if (classification !== "metadata-only") {
      symbolSeeds.push(group.symbol.id);
      if ((classification === "removed" || classification === "signature-changed") && group.symbol.exported && record?.fileNodeId) symbolSeeds.push(record.fileNodeId);
    }
    seedIds.push(...symbolSeeds);
    symbols.push({
      id: group.symbol.id,
      label: group.symbol.label,
      start: group.symbol.start,
      end: group.symbol.end,
      exported: group.symbol.exported,
      classification,
      reason: reasons[classification],
      addedLines: group.additions.map((change) => change.newLine).filter(Boolean),
      removedLines: group.removals.map((change) => change.oldLine).filter(Boolean),
      seedIds: [...new Set(symbolSeeds)].sort(),
    });
  }

  const unmappedCode = unmapped.filter((change) => !isMetadataLine(change.text));
  const unmappedMetadata = unmapped.length > 0 && !unmappedCode.length;
  let classification;
  let reason;
  if (parsed.binary) {
    classification = "unknown";
    reason = "binary diff has no line-level evidence";
  } else if (parsed.deletedFile) {
    classification = "removed";
    reason = "file removed";
  } else if (parsed.renamed) {
    classification = "signature-changed";
    reason = "file rename changes module identity";
  } else if (parsed.newFile) {
    classification = "added";
    reason = "new file; no existing dependent can target it yet";
  } else if (unmappedCode.some((change) => moduleSignatureText(change.text))) {
    classification = "signature-changed";
    reason = "module import/export surface changed outside a mapped symbol";
  } else if (unmappedCode.length) {
    classification = "unknown";
    reason = "executable diff lines could not be mapped to a graph symbol";
  } else if (symbols.length) {
    classification = strongest(symbols.map((symbol) => symbol.classification));
    reason = symbols.length === 1 ? symbols[0].reason : `${symbols.length} mapped symbols; strongest change is ${classification}`;
  } else if (unmappedMetadata || parsed.hunks.length || parsed.additions.length || parsed.removals.length) {
    classification = "metadata-only";
    reason = "only comment/blank metadata changed outside symbols";
  } else {
    classification = "metadata-only";
    reason = "file metadata changed without textual hunks";
  }

  if (parsed.binary || parsed.deletedFile || parsed.renamed || classification === "unknown") {
    if (record?.fileNodeId) seedIds.push(record.fileNodeId);
    if (parsed.binary || parsed.deletedFile || classification === "unknown") seedIds.push(...(record?.symbols || []).map((symbol) => symbol.id));
  } else if (classification === "signature-changed" && !symbols.length && record?.fileNodeId) {
    seedIds.push(record.fileNodeId);
  } else if (classification === "added" && includeAddedSeeds) {
    if (record?.fileNodeId) seedIds.push(record.fileNodeId);
    seedIds.push(...symbols.map((symbol) => symbol.id));
  }

  return {
    path,
    oldPath: parsed.oldPath,
    newPath: parsed.newPath,
    classification,
    reason,
    binary: parsed.binary,
    renamed: parsed.renamed,
    addedLines: parsed.additions.length,
    removedLines: parsed.removals.length,
    symbols,
    seedIds: [...new Set(seedIds)].sort(),
  };
}

function unknownFile(path, indexed, reason) {
  const normalized = normalizePath(path);
  const record = indexed.get(normalized);
  return {
    path: normalized,
    oldPath: normalized,
    newPath: normalized,
    classification: "unknown",
    reason,
    binary: false,
    renamed: false,
    addedLines: 0,
    removedLines: 0,
    symbols: [],
    seedIds: [record?.fileNodeId, ...(record?.symbols || []).map((symbol) => symbol.id)].filter(Boolean).sort(),
  };
}

function classifyTestSurface(file, pathClassifier) {
  const explanation = pathClassifier.explain(file.path);
  if (!hasPathClass(explanation, "test", "e2e")) return file;
  const surface = explanation.classes.includes("e2e") ? "e2e" : "test";
  return {
    ...file,
    classification: "test-only",
    changeClassification: file.classification,
    reason: `${surface} path; excluded from the product blast-radius seed set`,
    pathClasses: explanation.classes,
    seedIds: [],
  };
}

function runGitDiff(repoRoot, base, _files, limits) {
  const args = ["-C", repoRoot, "diff", "--no-ext-diff", "--find-renames", "--no-color", "--unified=0", String(base), "--"];
  const result = spawnSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 12_000,
    maxBuffer: limits.maxDiffBytes + 1,
    env: childProcessEnv(),
  });
  if (result.status === 0) return { available: true, text: String(result.stdout || ""), error: null };
  const oversized = result.error?.code === "ENOBUFS" || Buffer.byteLength(String(result.stdout || "")) > limits.maxDiffBytes;
  return { available: false, text: String(result.stdout || ""), oversized, error: oversized ? "git diff exceeded the byte limit" : String(result.stderr || result.error?.message || "git diff unavailable").trim() };
}

const validExplicitFiles = (files) => [...new Set((Array.isArray(files) ? files : [])
  .map(normalizePath)
  .filter((file) => file && !file.startsWith("../") && !file.includes("/../") && !file.startsWith("-")))]
  .sort((a, b) => a.localeCompare(b));

export function classifyChangeImpact({
  repoRoot = "",
  graph = {},
  base = "",
  diffText,
  files = [],
  includeAddedSeeds = false,
  limits: requestedLimits = {},
} = {}) {
  const limits = limitsOf(requestedLimits);
  const explicitFiles = validExplicitFiles(files);
  let source = "provided-diff";
  let available = typeof diffText === "string";
  let text = available ? diffText : "";
  let unavailableReason = "";
  let gitOversized = false;
  if (!available && repoRoot && base) {
    source = "git-diff";
    const result = runGitDiff(repoRoot, base, explicitFiles, limits);
    available = result.available;
    text = result.text;
    unavailableReason = result.error || "";
    gitOversized = result.oversized === true;
  } else if (!available) {
    source = "files-only";
    unavailableReason = "no unified diff was provided and no repoRoot/base pair was available";
  }

  const indexed = graphIndex(graph, limits);
  const pathClassifier = createPathClassifier(repoRoot);
  const parsed = available ? parseZeroContextDiff(text, limits) : { files: [], changedLines: 0, byteLength: 0, truncated: gitOversized, oversized: gitOversized, limits };
  const analyzed = parsed.files.map((file) => classifyTestSurface(
    analyzeParsedFile(file, indexed, { includeAddedSeeds }),
    pathClassifier,
  ));
  const represented = new Set(analyzed.flatMap((file) => [file.oldPath, file.newPath].filter(Boolean)));
  for (const file of explicitFiles) {
    if (!represented.has(file)) analyzed.push(classifyTestSurface(
      unknownFile(file, indexed, available ? "explicitly changed file had no textual hunk" : unavailableReason),
      pathClassifier,
    ));
  }
  if (!available && !explicitFiles.length) analyzed.push(unknownFile("(diff unavailable)", indexed, unavailableReason));
  analyzed.sort((a, b) => a.path.localeCompare(b.path));

  if (parsed.truncated || parsed.oversized || gitOversized) {
    for (const file of analyzed) {
      if (file.classification === "test-only") continue;
      file.classification = "unknown";
      file.reason = "diff was truncated/oversized; symbol-level classification is incomplete";
      const record = indexed.get(file.newPath) || indexed.get(file.oldPath);
      file.seedIds = [...new Set([record?.fileNodeId, ...(record?.symbols || []).map((symbol) => symbol.id), ...file.seedIds].filter(Boolean))].sort();
    }
  }

  const rawSeeds = analyzed.flatMap((file) => file.seedIds);
  const seeds = uniqueSorted(rawSeeds, limits.maxSeeds);
  let verdict = "LOW";
  for (const file of analyzed) {
    const next = ["removed", "signature-changed", "unknown"].includes(file.classification)
      ? "HIGH"
      : file.classification === "body-changed" ? "MEDIUM" : "LOW";
    if (VERDICT_RANK[next] > VERDICT_RANK[verdict]) verdict = next;
  }
  if (!available || parsed.truncated || seeds.truncated) verdict = "HIGH";

  const counts = Object.fromEntries(Object.keys(CLASS_RANK).map((name) => [name, analyzed.filter((file) => file.classification === name).length]));
  const reasons = [];
  if (!available) reasons.push(`Diff unavailable: ${unavailableReason || "unknown error"}; using conservative file/symbol seeds.`);
  if (parsed.truncated || parsed.oversized || gitOversized) reasons.push("Diff exceeded a safety bound; incomplete evidence is classified HIGH/unknown.");
  if (counts.removed || counts["signature-changed"]) reasons.push(`${counts.removed} removed and ${counts["signature-changed"]} signature/module-surface file change(s) can break existing callers.`);
  if (counts["body-changed"]) reasons.push(`${counts["body-changed"]} file(s) contain mapped executable body changes.`);
  if (counts.added && !includeAddedSeeds) reasons.push(`${counts.added} purely additive file change(s) create no dependent seeds by default.`);
  if (counts["metadata-only"]) reasons.push(`${counts["metadata-only"]} metadata-only file change(s) create no dependent seeds.`);
  if (counts["test-only"]) reasons.push(`${counts["test-only"]} test-only file change(s) are labelled explicitly and create no product blast-radius seeds.`);
  if (counts.unknown) reasons.push(`${counts.unknown} file change(s) remain unknown and are seeded conservatively.`);
  if (!reasons.length) reasons.push("No changed files were present in the supplied diff.");

  return {
    ok: available && !parsed.truncated && !seeds.truncated,
    source,
    verdict,
    reasons,
    seedIds: seeds.items,
    files: analyzed,
    summary: {
      files: analyzed.length,
      symbols: analyzed.reduce((sum, file) => sum + file.symbols.length, 0),
      counts,
      seeds: seeds.items.length,
      totalSeedsBeforeCap: seeds.total,
    },
    bounds: {
      ...limits,
      diffBytes: parsed.byteLength,
      changedLines: parsed.changedLines,
      truncated: !!parsed.truncated || seeds.truncated,
    },
  };
}

export { DEFAULT_LIMITS as CHANGE_CLASSIFICATION_LIMITS };
