// Aggregating a built graph.json into the file/module/symbol rollup the UI needs. `aggregateGraph`
// is pure over the parsed graph (covered by tests) apart from optional repoRoot file reads;
// `analyzeGraph` reads the graph file from disk first.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepoParts, readCoverageForRepo, pctFromCounts } from "./coverage-reports.js";
import { bareSymbolName, countLocalRefsOutsideOwnRange, computeSymbolExternalRefs } from "./graph-analysis.refs.js";
import { createRepoBoundary } from "../repo-path.js";
import { edgeList, folderModuleOf } from "./graph-analysis.edges.js";
export { folderModuleOf } from "./graph-analysis.edges.js";

// Aggregate a built graph.json into the file- and module-level view the UI needs:
//   - graph-builder nodes are FILES *and* their symbols (functions/methods), linked file→symbol by the
//     "contains" relation. So a community's raw node count (what the cards show) is NOT a file count.
//   - Each file is assigned to ONE module via its file-node's community (symbols may cluster apart,
//     but the file itself belongs where its file-node sits) → exact, non-overlapping file counts.
//   - Real edges (everything except "contains") roll up to file→file and module→module relations.
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
  // In a merged (cross-repo) graph every node carries a `repo`; qualify file & module identity by it
  // so same-named folders/files in different repos never merge. Single-repo graphs have no `repo`,
  // so identity stays the bare path (unchanged behavior).
  const fileIdOf = (node) => (node.repo ? `${node.repo}::${node.source_file}` : node.source_file);
  const moduleOfNode = (node) => (node.repo ? `${node.repo}/` : "") + folderModuleOf(node.source_file);

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
        ...(node.decorated ? { decorated: true } : {}),
        ...(node.symbol_kind ? {symbolKind: node.symbol_kind} : {}),
        ...(node.symbol_space ? {symbolSpace: node.symbol_space} : {})
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
  const typeOnlyFileEdges = new Map();
  const typeOnlyModuleEdges = new Map();
  const compileOnlyFileEdges = new Map();
  const compileOnlyModuleEdges = new Map();
  const compileTimeFileEdges = new Map();
  const compileTimeModuleEdges = new Map();
  const addFileEdge = (map, key, link) => {
    let edge = map.get(key);
    if (!edge) map.set(key, (edge = { count: 0, rels: {} }));
    edge.count++;
    if (link.relation) edge.rels[link.relation] = (edge.rels[link.relation] || 0) + 1;
  };
  for (const link of links) {
    if (link.relation === "contains" || link.barrelProxy === true) continue;
    const fromFile = id2file.get(endpoint(link.source));
    const toFile = id2file.get(endpoint(link.target));
    if (fromFile && toFile && fromFile !== toFile) {
      const key = `${fromFile} ${toFile}`;
      const compileTime = link.typeOnly === true || link.compileOnly === true;
      const targetFileEdges = link.typeOnly === true ? typeOnlyFileEdges : link.compileOnly === true ? compileOnlyFileEdges : fileEdges;
      addFileEdge(targetFileEdges, key, link);
      if (compileTime) addFileEdge(compileTimeFileEdges, key, link);
      const fromMod = fileModule.get(fromFile);
      const toMod = fileModule.get(toFile);
      if (fromMod && toMod && fromMod !== toMod) {
        const mkey = `${fromMod} ${toMod}`;
        const targetModuleEdges = link.typeOnly === true ? typeOnlyModuleEdges : link.compileOnly === true ? compileOnlyModuleEdges : moduleEdges;
        targetModuleEdges.set(mkey, (targetModuleEdges.get(mkey) || 0) + 1);
        if (compileTime) compileTimeModuleEdges.set(mkey, (compileTimeModuleEdges.get(mkey) || 0) + 1);
      }
    }
  }
  // symbol-level (function/method) call graph: edges between symbol nodes (calls/method), each symbol
  // tagged with its file's module so the Symbols view can still cluster into module regions.
  const symEdges = new Map();
  for (const link of links) {
    if (link.relation === "contains" || link.barrelProxy === true) continue;
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
    const boundary = createRepoBoundary(repoRoot);
    folderLoc = {};
    for (const [sourceFile, mod] of fileModule) {
      let loc = 0;
      try {
        const resolved = boundary.resolve(sourceFile);
        if (!resolved.ok) throw new Error("source path is outside the repository");
        const txt = readFileSync(resolved.path, "utf8");
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

  const symbolExternalRefs = computeSymbolExternalRefs(filePath, fileSymbols, fileText);

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
    typeOnlyModuleEdges: edgeList(typeOnlyModuleEdges),
    compileOnlyModuleEdges: edgeList(compileOnlyModuleEdges),
    compileTimeModuleEdges: edgeList(compileTimeModuleEdges),
    fileEdges: edgeList(fileEdges),
    typeOnlyFileEdges: edgeList(typeOnlyFileEdges),
    compileOnlyFileEdges: edgeList(compileOnlyFileEdges),
    compileTimeFileEdges: edgeList(compileTimeFileEdges),
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
      typeOnlyFileEdges: typeOnlyFileEdges.size,
      compileOnlyFileEdges: compileOnlyFileEdges.size,
      compileTimeFileEdges: compileTimeFileEdges.size,
      moduleEdges: moduleEdges.size,
      typeOnlyModuleEdges: typeOnlyModuleEdges.size,
      compileOnlyModuleEdges: compileOnlyModuleEdges.size,
      compileTimeModuleEdges: compileTimeModuleEdges.size,
      symbols: symbols.length,
      symbolEdges: symbolEdges.length
    }
  };
}
