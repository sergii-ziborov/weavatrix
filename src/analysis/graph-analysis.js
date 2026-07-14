// Reading a built graph.json and aggregating it into the views the UI needs: named communities,
// degree hotspots, and the file/module/symbol rollup. `aggregateGraph` is pure (covered by tests);
// the rest read the graph file from disk.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bareSymbolName = (label) => String(label || "").replace(/\s*\(.*$/, "").trim();
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

function countLocalRefsOutsideOwnRange(text, name, startLine, endLine) {
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

import { normRepoPath, normalizeRepoParts, dirOfRepoPath, readCoverageForRepo, pctFromCounts } from "./coverage-reports.js";

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

// graph-builder labels communities "Community N" without an LLM. Derive a real name from each
// community's dominant folder + sample files so the UI shows modules, not bare numbers.
export function summarizeCommunities(graphJsonPath, max = 40) {
  try {
    const graph = JSON.parse(readFileSync(graphJsonPath, "utf8"));
    const byCommunity = new Map();
    for (const node of graph.nodes || []) {
      if (node.file_type !== "code") continue;
      const community = node.community;
      if (community === undefined || community === null) continue;
      if (!byCommunity.has(community)) byCommunity.set(community, { id: community, size: 0, dirs: new Map(), files: [] });
      const entry = byCommunity.get(community);
      entry.size += 1;
      const parts = String(node.source_file || "").split(/[\\/]/).filter(Boolean);
      const dir = parts.length > 1 ? parts.slice(0, 2).join("/") : "(root)";
      entry.dirs.set(dir, (entry.dirs.get(dir) || 0) + 1);
      if (entry.files.length < 4) entry.files.push(parts[parts.length - 1] || node.source_file || "");
    }
    return [...byCommunity.values()]
      .map((entry) => {
        const dominant = [...entry.dirs.entries()].sort((left, right) => right[1] - left[1])[0];
        return { id: entry.id, size: entry.size, name: dominant ? dominant[0] : "(mixed)", files: entry.files };
      })
      .sort((left, right) => right.size - left.size)
      .slice(0, max);
  } catch {
    return [];
  }
}

// Top nodes by total degree (in+out) — the "load-bearing" / refactor-candidate hotspots.
export function summarizeHotspots(graphJsonPath, max = 15) {
  try {
    const graph = JSON.parse(readFileSync(graphJsonPath, "utf8"));
    const nodes = graph.nodes || [];
    const endpoint = (value) => (value && typeof value === "object" ? value.id : value);
    const inDeg = new Map();
    const outDeg = new Map();
    for (const link of graph.links || []) {
      const s = endpoint(link.source);
      const t = endpoint(link.target);
      outDeg.set(s, (outDeg.get(s) || 0) + 1);
      inDeg.set(t, (inDeg.get(t) || 0) + 1);
    }
    return nodes
      .filter((node) => node.file_type === "code")
      .map((node) => {
        const inbound = inDeg.get(node.id) || 0;
        const outbound = outDeg.get(node.id) || 0;
        return { label: node.label || node.norm_label || node.id, file: node.source_file || "", in: inbound, out: outbound, degree: inbound + outbound };
      })
      .filter((node) => node.degree > 0)
      .sort((left, right) => right.degree - left.degree)
      .slice(0, max);
  } catch {
    return [];
  }
}

// Aggregate a built graph.json into the file- and module-level view the UI needs:
//   - graph-builder nodes are FILES *and* their symbols (functions/methods), linked file→symbol by the
//     "contains" relation. So a community's raw node count (what the cards show) is NOT a file count.
//   - Each file is assigned to ONE module via its file-node's community (symbols may cluster apart,
//     but the file itself belongs where its file-node sits) → exact, non-overlapping file counts.
//   - Real edges (everything except "contains") roll up to file→file and module→module relations.
// Module names match summarizeCommunities (dominant first-two-path-parts), so they line up with cards.
export function analyzeGraph(graphJsonPath, repoRoot) {
  let graph;
  try {
    graph = JSON.parse(readFileSync(graphJsonPath, "utf8"));
  } catch {
    return null;
  }
  return aggregateGraph(graph, repoRoot);
}

// Pure aggregation over an already-parsed graph object — split out of analyzeGraph so it can be
// unit-tested without a graph.json on disk. Touches the filesystem only when repoRoot is provided
// (to read each source file's line count for the size colouring).
export function aggregateGraph(graph, repoRoot) {
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const endpoint = (value) => (value && typeof value === "object" ? value.id : value);

  // symbol nodes = targets of a "contains" edge (a file "contains" its functions/methods)
  const symbolIds = new Set();
  for (const link of links) if (link.relation === "contains") symbolIds.add(endpoint(link.target));

  // community → dominant folder name (over all code nodes — same rule as summarizeCommunities)
  // MODULE = the file's own top FOLDER (its "territory"), up to 2 path levels — NOT a dependency
  // cluster. e.g. src/widget/foo.js → "src/widget"; benchmarks/cleanup.py → "benchmarks" (so all
  // benchmarks files are one module); a top-level file like index.js → "(root)".
  const folderOf = (file) => {
    const dirs = String(file || "").split(/[\\/]/).filter(Boolean).slice(0, -1);
    return dirs.length ? dirs.slice(0, 2).join("/") : "(root)";
  };
  // In a merged (cross-repo) graph every node carries a `repo`; qualify file & module identity by it
  // so same-named folders/files in different repos never merge. Single-repo graphs have no `repo`,
  // so identity stays the bare path (unchanged behavior).
  const fileIdOf = (node) => (node.repo ? `${node.repo}::${node.source_file}` : node.source_file);
  const moduleOfNode = (node) => (node.repo ? `${node.repo}/` : "") + folderOf(node.source_file);

  // file → module (folder) + symbols + display path, all keyed by repo-qualified file id
  const fileModule = new Map();
  const fileSymbols = new Map();
  const filePath = new Map();
  const moduleRepo = new Map();
  for (const node of nodes) {
    if (node.file_type !== "code" || !node.source_file) continue;
    const fid = fileIdOf(node);
    if (symbolIds.has(node.id)) {
      const list = fileSymbols.get(fid) || [];
      list.push({
        id: node.id,
        label: node.label || node.norm_label || node.id,
        line: String(node.source_location || "").replace(/^L/, ""),
        endLine: String(node.source_end || "").replace(/^L/, ""),
        ...(node.complexity ? { complexity: node.complexity } : {}),
        ...(node.decorated ? { decorated: true } : {})
      });
      fileSymbols.set(fid, list);
    }
    if (!fileModule.has(fid)) {
      const mod = moduleOfNode(node);
      fileModule.set(fid, mod);
      filePath.set(fid, node.source_file);
      if (node.repo) moduleRepo.set(mod, node.repo);
    }
  }

  // raw node count per module (files + their symbols), for the honest "X files · Y nodes"
  const moduleNodeCount = new Map();
  for (const node of nodes) {
    if (node.file_type !== "code" || !node.source_file) continue;
    const name = moduleOfNode(node);
    moduleNodeCount.set(name, (moduleNodeCount.get(name) || 0) + 1);
  }

  // modules: folder → its files (+ symbol breakdown). `repo` is set for cross-repo graphs.
  const modules = new Map();
  for (const [fid, name] of fileModule) {
    const mod = modules.get(name) || { name, repo: moduleRepo.get(name) || null, files: [] };
    const symbols = fileSymbols.get(fid) || [];
    mod.files.push({ file: fid, path: filePath.get(fid) || fid, symbolCount: symbols.length, symbols: symbols.slice(0, 300) });
    modules.set(name, mod);
  }

  // file→file and module→module edges (skip "contains"; map endpoints by repo-qualified file / module)
  const id2file = new Map();
  for (const node of nodes) if (node.source_file) id2file.set(node.id, fileIdOf(node));
  const fileEdges = new Map(); // key → { count, rels:{relation→n} } so we can emit the DOMINANT relation (call/import/inherit)
  const moduleEdges = new Map();
  for (const link of links) {
    if (link.relation === "contains") continue;
    const fromFile = id2file.get(endpoint(link.source));
    const toFile = id2file.get(endpoint(link.target));
    if (fromFile && toFile && fromFile !== toFile) {
      const key = `${fromFile} ${toFile}`;
      let fe = fileEdges.get(key);
      if (!fe) fileEdges.set(key, (fe = { count: 0, rels: {} }));
      fe.count++;
      if (link.relation) fe.rels[link.relation] = (fe.rels[link.relation] || 0) + 1;
      const fromMod = fileModule.get(fromFile);
      const toMod = fileModule.get(toFile);
      if (fromMod && toMod && fromMod !== toMod) {
        const mkey = `${fromMod} ${toMod}`;
        moduleEdges.set(mkey, (moduleEdges.get(mkey) || 0) + 1);
      }
    }
  }
  const split = (key) => {
    const i = key.indexOf(" ");
    return [key.slice(0, i), key.slice(i + 1)];
  };
  const edgeList = (map) =>
    [...map.entries()]
      .map(([key, v]) => {
        const [from, to] = split(key);
        if (typeof v === "number") return { from, to, count: v }; // moduleEdges (no relation breakdown)
        const dom = Object.entries(v.rels).sort((a, b) => b[1] - a[1])[0];
        return { from, to, count: v.count, relation: dom ? dom[0] : null };
      })
      .sort((a, b) => b.count - a.count);

  // symbol-level (function/method) call graph: edges between symbol nodes (calls/method), each symbol
  // tagged with its file's module so the Symbols view can still cluster into module regions.
  const symEdges = new Map();
  for (const link of links) {
    if (link.relation === "contains") continue;
    const s = endpoint(link.source);
    const t = endpoint(link.target);
    if (s === t || !symbolIds.has(s) || !symbolIds.has(t)) continue;
    const key = `${s}\t${t}`;
    symEdges.set(key, (symEdges.get(key) || 0) + 1);
  }
  const connectedSyms = new Set();
  for (const key of symEdges.keys()) {
    const tab = key.indexOf("\t");
    connectedSyms.add(key.slice(0, tab));
    connectedSyms.add(key.slice(tab + 1));
  }
  const symbols = [];
  for (const node of nodes) {
    if (!symbolIds.has(node.id) || !connectedSyms.has(node.id)) continue;
    const fid = fileIdOf(node);
    symbols.push({
      id: node.id,
      label: node.label || node.norm_label || node.id,
      file: node.source_file || "",
      module: fileModule.get(fid) || moduleOfNode(node),
      line: String(node.source_location || "").replace(/^L/, ""),
      endLine: String(node.source_end || "").replace(/^L/, ""),
      ...(node.complexity ? { complexity: node.complexity } : {})
    });
  }
  const symbolEdges = [...symEdges.entries()]
    .map(([key, count]) => {
      const tab = key.indexOf("\t");
      return { from: key.slice(0, tab), to: key.slice(tab + 1), count };
    })
    .sort((a, b) => b.count - a.count);

  // lines of code per folder (best-effort — needs the repo on disk; absent for merged combos) so the
  // UI can color folders blue→red by size.
  let folderLoc = null;
  const fileLoc = new Map();
  const fileText = new Map();
  if (repoRoot) {
    folderLoc = {};
    for (const [sourceFile, mod] of fileModule) {
      let loc = 0;
      try {
        const txt = readFileSync(join(repoRoot, sourceFile), "utf8");
        loc = txt ? txt.split("\n").length : 0;
        fileText.set(sourceFile, txt || "");
      } catch {
        /* file may be gone — skip */
      }
      fileLoc.set(sourceFile, loc);
      folderLoc[mod] = (folderLoc[mod] || 0) + loc;
    }
  }
  const coverageByFile = repoRoot ? readCoverageForRepo(repoRoot, [...filePath.values()]) : new Map();
  const coverageForFile = (fid) => coverageByFile.get(normalizeRepoParts(filePath.get(fid) || fid)) || null;
  const coverageForRange = (fid, startLine, endLine) => {
    const cov = coverageForFile(fid);
    if (!cov) return null;
    if (!(cov.lines instanceof Map) || !cov.lines.size || !Number.isFinite(startLine) || !Number.isFinite(endLine)) return cov.pct ?? null;
    let total = 0;
    let covered = 0;
    for (let line = Math.max(1, startLine); line <= Math.max(startLine, endLine); line++) {
      if (!cov.lines.has(line)) continue;
      total++;
      if (Number(cov.lines.get(line)) > 0) covered++;
    }
    return total ? pctFromCounts(covered, total) : cov.pct ?? null;
  };

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

  // Prefer the exact AST end line emitted by the internal builder. Older graph.json files only carry a
  // start line, so keep the historical next-declaration/EOF approximation as a compatibility fallback.
  const symbolLoc = new Map();
  const symbolCoverage = new Map();
  // Source-level refs catch local value/constants usage that graph-builder's call edges can miss.
  const symbolLocalRefs = new Map();
  for (const [fid, list] of fileSymbols) {
    const total = fileLoc.get(fid) || 0;
    const txt = fileText.get(fid) || "";
    const sorted = list
      .map((s) => ({ id: s.id, label: s.label, start: parseInt(s.line, 10), end: parseInt(s.endLine, 10), ref: s }))
      .filter((s) => Number.isFinite(s.start) && s.start > 0)
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i].start;
      const next = i + 1 < sorted.length ? sorted[i + 1].start : total > start ? total + 1 : start + 1;
      const exactEnd = Number.isFinite(sorted[i].end) && sorted[i].end >= start ? sorted[i].end : 0;
      const end = exactEnd || Math.max(start, next - 1);
      const loc = Math.max(1, end - start + 1);
      symbolLoc.set(sorted[i].id, loc);
      sorted[i].ref.loc = loc;
      sorted[i].ref.endLine = end;
      const cov = coverageForRange(fid, start, end);
      if (cov != null) symbolCoverage.set(sorted[i].id, cov);
      const refs = countLocalRefsOutsideOwnRange(txt, bareSymbolName(sorted[i].label), start, end);
      if (refs > 0) symbolLocalRefs.set(sorted[i].id, refs);
    }
  }
  for (const s of symbols) {
    const fid = id2file.get(s.id);
    s.loc = symbolLoc.get(s.id) || 0;
    s.coverage = symbolCoverage.get(s.id) ?? coverageForFile(fid)?.pct ?? null;
  }

  return {
    complexityV: Number(graph.complexityV) || 0,
    modules: [...modules.values()]
      .map((mod) => ({
        name: mod.name,
        repo: mod.repo || null,
        fileCount: mod.files.length,
        nodeCount: moduleNodeCount.get(mod.name) || 0,
        symbolCount: mod.files.reduce((sum, f) => sum + f.symbolCount, 0),
        files: mod.files
          .map((f) => {
            const cov = coverageForFile(f.file);
            return { ...f, loc: fileLoc.get(f.file) || 0, coverage: cov?.pct ?? null, coverageSource: cov?.source || "" };
          })
          .sort((a, b) => b.symbolCount - a.symbolCount)
      }))
      .sort((a, b) => b.fileCount - a.fileCount),
    moduleEdges: edgeList(moduleEdges),
    fileEdges: edgeList(fileEdges),
    symbols,
    symbolEdges,
    symbolRefs: [...new Set([...symbolLocalRefs.keys(), ...symbolExternalRefs.keys()])].map((id) => {
      const sourceRefs = symbolLocalRefs.get(id) || 0;
      const externalRefs = symbolExternalRefs.get(id) || 0;
      return { id, localRefs: sourceRefs + externalRefs, sourceRefs, externalRefs };
    }),
    folderLoc,
    totals: {
      files: fileModule.size,
      nodes: nodes.filter((n) => n.file_type === "code").length,
      fileEdges: fileEdges.size,
      moduleEdges: moduleEdges.size,
      symbols: symbols.length,
      symbolEdges: symbolEdges.length
    }
  };
}
