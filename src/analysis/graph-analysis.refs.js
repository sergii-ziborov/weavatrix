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
    .replace(/\bexport\s+\{[\s\S]*?\}\s+from\s*['"][^'"]+['"]\s*;?/g, "")
    .replace(/\b(?:const|let|var)\s+\{[\s\S]*?\}\s*=\s*require\(\s*['"][^'"]+['"]\s*\)\s*;?/g, "");
}

function parseNamedSpecifiers(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      return m ? { imported: m[1], local: m[2] || m[1] } : null;
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
      ids.push(sym.id);
      byName.set(name, ids);
    }
    symbolIdsByFileAndName.set(fid, byName);
  }

  const symbolExternalRefs = new Map();
  const addExternalRefs = (targetFid, importedName, refs) => {
    if (!targetFid || refs <= 0 || !isIdentifierName(importedName)) return;
    const ids = symbolIdsByFileAndName.get(targetFid)?.get(importedName) || [];
    for (const id of ids) symbolExternalRefs.set(id, (symbolExternalRefs.get(id) || 0) + refs);
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
        for (const spec of parseNamedSpecifiers(named[1])) addExternalRefs(targetFid, spec.imported, countIdentifierInText(scrubbed, spec.local));
      }
      const ns = String(m[1] || "").match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (ns) {
        const byName = symbolIdsByFileAndName.get(targetFid) || new Map();
        for (const name of byName.keys()) addExternalRefs(targetFid, name, countMemberAccess(scrubbed, ns[1], name));
      }
    }
    for (const m of String(txt).matchAll(/\bexport\s+\{([\s\S]*?)\}\s+from\s*['"]([^'"]+)['"]\s*;?/g)) {
      const targetFid = resolveImportedFid(importerPath, m[2]);
      if (!targetFid) continue;
      for (const spec of parseNamedSpecifiers(m[1])) addExternalRefs(targetFid, spec.imported, 1);
    }
    for (const m of String(txt).matchAll(/\b(?:const|let|var)\s+\{([\s\S]*?)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g)) {
      const targetFid = resolveImportedFid(importerPath, m[2]);
      if (!targetFid) continue;
      for (const spec of parseNamedSpecifiers(m[1])) addExternalRefs(targetFid, spec.imported, countIdentifierInText(scrubbed, spec.local));
    }
  }
  return symbolExternalRefs;
}
