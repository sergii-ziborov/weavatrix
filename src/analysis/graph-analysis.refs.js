// Internal helpers for graph-analysis: identifier reference counting inside source text,
// relative-import candidate resolution, and the import-driven external-reference scan that feeds
// aggregateGraph's symbolRefs output. Not part of the public graph-analysis facade.
import { normRepoPath, normalizeRepoParts, dirOfRepoPath } from "./coverage-reports.js";

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const bareSymbolName = (label) => String(label || "").replace(/\s*\(.*$/, "").trim();
const isIdentifierName = (name) => /^[A-Za-z_$][\w$]*$/.test(name);

function countIdentifierInLine(line, name) {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`, "g");
  let count = 0;
  while (re.exec(line)) count++;
  return count;
}

function countIdentifierInText(text, name) {
  if (!text || !isIdentifierName(name)) return 0;
  return String(text).split(/\r?\n/).reduce((sum, line) => sum + countIdentifierInLine(line, name), 0);
}

function countMemberAccess(text, objectName, memberName) {
  if (!text || !isIdentifierName(objectName) || !isIdentifierName(memberName)) return 0;
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(objectName)}\\s*\\.\\s*${escapeRegExp(memberName)}(?![A-Za-z0-9_$])`, "g");
  let count = 0;
  while (re.exec(String(text))) count++;
  return count;
}

export function countLocalRefsOutsideOwnRange(text, name, startLine, endLine) {
  if (!text || !isIdentifierName(name)) return 0;
  const start = Number.isFinite(startLine) && startLine > 0 ? startLine : 0;
  const end = Number.isFinite(endLine) && endLine >= start ? endLine : start;
  let refs = 0;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (start && lineNo >= start && lineNo <= end) continue;
    refs += countIdentifierInLine(lines[i], name);
  }
  return refs;
}

const lowerBound = (values, target) => {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

// Count every wanted identifier in a file once, then subtract occurrences inside each declaration
// with binary searches over occurrence line numbers. The former per-symbol full-file scan became
// quadratic on large vendored files (thousands of symbols over tens of thousands of lines).
export function computeLocalSymbolRefs(text, symbols) {
  const candidates = (symbols || []).map((symbol) => ({
    id: symbol.id,
    name: bareSymbolName(symbol.name ?? symbol.label),
    start: Number(symbol.startLine ?? symbol.start),
    end: Number(symbol.endLine ?? symbol.end),
  })).filter((symbol) => symbol.id && isIdentifierName(symbol.name));
  if (!text || !candidates.length) return new Map();
  const wanted = new Set(candidates.map((symbol) => symbol.name));
  const occurrenceLines = new Map();
  const identifier = /[A-Za-z_$][\w$]*/g;
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    identifier.lastIndex = 0;
    let match;
    while ((match = identifier.exec(lines[index]))) {
      const name = match[0];
      if (!wanted.has(name)) continue;
      const positions = occurrenceLines.get(name) || [];
      positions.push(index + 1);
      occurrenceLines.set(name, positions);
    }
  }
  const refs = new Map();
  for (const symbol of candidates) {
    const positions = occurrenceLines.get(symbol.name) || [];
    const start = Number.isFinite(symbol.start) && symbol.start > 0 ? symbol.start : 0;
    const end = Number.isFinite(symbol.end) && symbol.end >= start ? symbol.end : start;
    const inside = start ? lowerBound(positions, end + 1) - lowerBound(positions, start) : 0;
    const outside = Math.max(0, positions.length - inside);
    if (outside > 0) refs.set(symbol.id, outside);
  }
  return refs;
}

function importCandidates(fromFile, spec) {
  const raw = String(spec || "");
  if (!raw.startsWith(".")) return [];
  const base = normalizeRepoParts(`${dirOfRepoPath(fromFile)}/${raw}`);
  return [
    base,
    `${base}.js`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.js`,
    `${base}/index.ts`,
    `${base}/index.jsx`,
    `${base}/index.tsx`
  ];
}

function stripModuleStatements(text) {
  return String(text || "")
    .replace(/\bimport\s+[\s\S]*?\s+from\s*['"][^'"]+['"]\s*;?/g, "")
    .replace(/\bexport\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s*['"][^'"]+['"]\s*;?/g, "")
    .replace(/\b(?:const|let|var)\s+\{[\s\S]*?\}\s*=\s*require\(\s*['"][^'"]+['"]\s*\)\s*;?/g, "");
}

function parseNamedSpecifiers(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const typeOnly = /^type\s+/.test(part);
      const clean = part.replace(/^type\s+/, "").trim();
      const m = clean.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      return m ? { imported: m[1], local: m[2] || m[1], typeOnly } : null;
    })
    .filter(Boolean);
}

// Import-driven external references: scan each file's import/export/require statements and count how
// often the imported names are used in the importer, attributing counts to the target file's symbol
// ids. Moved whole out of aggregateGraph; parameters are its `filePath` (fid → repo path),
// `fileSymbols` (fid → symbol list) and `fileText` (fid → source text) maps.
export function computeSymbolExternalRefs(filePath, fileSymbols, fileText) {
  const fidByPath = new Map();
  for (const [fid, p] of filePath) fidByPath.set(normRepoPath(p), fid);
  const symbolIdsByFileAndName = new Map();
  for (const [fid, list] of fileSymbols) {
    const byName = symbolIdsByFileAndName.get(fid) || new Map();
    for (const sym of list || []) {
      const name = bareSymbolName(sym.label);
      if (!isIdentifierName(name)) continue;
      const ids = byName.get(name) || [];
      ids.push({id: sym.id, space: sym.symbolSpace || "value"});
      byName.set(name, ids);
    }
    symbolIdsByFileAndName.set(fid, byName);
  }

  const symbolExternalRefs = new Map();
  const addExternalRefs = (targetFid, importedName, refs, typeOnly = false) => {
    if (!targetFid || refs <= 0 || !isIdentifierName(importedName)) return;
    const ids = symbolIdsByFileAndName.get(targetFid)?.get(importedName) || [];
    for (const entry of ids) {
      const matches = entry.space === "both" || (typeOnly ? entry.space === "type" : entry.space !== "type");
      if (matches) symbolExternalRefs.set(entry.id, (symbolExternalRefs.get(entry.id) || 0) + refs);
    }
  };
  const resolveImportedFid = (fromPath, spec) => {
    for (const candidate of importCandidates(fromPath, spec)) {
      const fid = fidByPath.get(candidate);
      if (fid) return fid;
    }
    return "";
  };
  for (const [importerFid, txt] of fileText) {
    const importerPath = filePath.get(importerFid) || importerFid;
    const scrubbed = stripModuleStatements(txt);
    const seenStatements = [
      ...String(txt).matchAll(/\bimport\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]\s*;?/g)
    ];
    for (const m of seenStatements) {
      const targetFid = resolveImportedFid(importerPath, m[2]);
      if (!targetFid) continue;
      const named = String(m[1] || "").match(/\{([\s\S]*?)\}/);
      if (named) {
        const statementTypeOnly = /^\s*type\b/.test(String(m[1] || ""));
        for (const spec of parseNamedSpecifiers(named[1])) addExternalRefs(targetFid, spec.imported, countIdentifierInText(scrubbed, spec.local), statementTypeOnly || spec.typeOnly);
      }
      const ns = String(m[1] || "").match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (ns) {
        const byName = symbolIdsByFileAndName.get(targetFid) || new Map();
        const statementTypeOnly = /^\s*type\b/.test(String(m[1] || ""));
        for (const name of byName.keys()) addExternalRefs(targetFid, name, countMemberAccess(scrubbed, ns[1], name), statementTypeOnly);
      }
    }
    for (const m of String(txt).matchAll(/\bexport\s+(type\s+)?\{([\s\S]*?)\}\s+from\s*['"]([^'"]+)['"]\s*;?/g)) {
      const targetFid = resolveImportedFid(importerPath, m[3]);
      if (!targetFid) continue;
      const statementTypeOnly = Boolean(m[1]);
      for (const spec of parseNamedSpecifiers(m[2])) addExternalRefs(targetFid, spec.imported, 1, statementTypeOnly || spec.typeOnly);
    }
    for (const m of String(txt).matchAll(/\b(?:const|let|var)\s+\{([\s\S]*?)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g)) {
      const targetFid = resolveImportedFid(importerPath, m[2]);
      if (!targetFid) continue;
      for (const spec of parseNamedSpecifiers(m[1])) addExternalRefs(targetFid, spec.imported, countIdentifierInText(scrubbed, spec.local));
    }
  }
  return symbolExternalRefs;
}
