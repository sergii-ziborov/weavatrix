// Orchestrator for the internal graph builder: the two-pass parse loop, community bucketing, and the
// graph.json writer. (Split from internal-builder.js — see its doc comment for the overall architecture;
// the language registry / parser lifecycle / walk live in ./internal-builder.langs.js and the per-repo
// resolvers in ./internal-builder.resolvers.js.)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, relative, dirname } from "node:path";
import { specToPkg } from "./builder/spec-pkg.js";
import { analyzeSyntaxComplexity } from "../analysis/source-complexity.js";
import { Parser, Query, GRAMMARS, LANGS, EXT_LANG, FAMILY, isDataFile, isDocFile, MAX_PARSE_BYTES, ensureParser, walk } from "./internal-builder.langs.js";
import { buildResolvers } from "./internal-builder.resolvers.js";
import { scanEmbeddedSql, resolveSqlReferences } from "./builder/lang-sql.js";
import { assignDeterministicCommunities } from "./community.js";
import { snapshotRepository } from "./incremental-refresh.js";
import { EDGE_PROVENANCE_V, stampEdgeProvenance } from "./edge-provenance.js";
import {runInternalGraphPass2} from './internal-builder.pass2.js'

function physicalLineCount(text) {
  if (!text.length) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}

// Parse a repo directory into a graph-builder-compatible { nodes, links } graph.
export async function buildInternalGraph(repoDir, opts = {}) {
  const rel = (p) => relative(repoDir, p).replace(/\\/g, "/");
  const allFiles = walk(repoDir);
  const snapshot = snapshotRepository(repoDir, allFiles);
  const requestedFiles = Array.isArray(opts.includeFiles)
    ? new Set(opts.includeFiles.map((file) => String(file).replace(/\\/g, "/").replace(/^\.\//, "")))
    : null;
  const files = requestedFiles ? allFiles.filter((file) => requestedFiles.has(rel(file))) : allFiles;
  // Lazy grammar loading: compile only the WASMs for languages this repo actually contains.
  const wanted = new Set();
  for (const f of files) { const g = EXT_LANG[extname(f)]; if (g) wanted.add(g); }
  const langs = await ensureParser(opts, wanted);
  const qc = new Map();
  const q = (grammar, src) => { const k = grammar + ":" + src; if (qc.has(k)) return qc.get(k); let x = null; try { x = new Query(langs[grammar], src); } catch { x = null; } qc.set(k, x); return x; };
  const caps = (grammar, src, root) => { const query = src && q(grammar, src); return query ? query.captures(root) : []; };
  const field = (n, f) => (n && n.childForFieldName ? n.childForFieldName(f) : null);

  const fileSet = new Set(allFiles.map(rel));
  const nodes = []; const links = []; const nodeIds = new Set(); const nodeById = new Map();
  const addNode = (n) => { if (!nodeIds.has(n.id)) { nodeIds.add(n.id); nodes.push(n); nodeById.set(n.id, n); } };
  const perFileSymbols = new Map();
  const symByFileName = new Map();
  const symIdsByFileName = new Map();
  const importedLocals = new Map();
  const jsExports = new Map();
  if (requestedFiles && opts.baseGraph?.jsExportRecords) {
    for (const [file, records] of Object.entries(opts.baseGraph.jsExportRecords)) {
      if (!requestedFiles.has(file) && Array.isArray(records)) jsExports.set(file, records.map((record) => ({ ...record })));
    }
  }
  if (requestedFiles && Array.isArray(opts.baseGraph?.nodes)) {
    for (const node of opts.baseGraph.nodes) {
      const id = String(node?.id || "");
      const file = String(node?.source_file || (id.includes("#") ? id.slice(0, id.indexOf("#")) : id)).replace(/\\/g, "/");
      if (!id.includes("#") || requestedFiles.has(file) || !fileSet.has(file)) continue;
      const match = id.match(/#([A-Za-z_$][\w$]*)@\d+/);
      if (!match) continue;
      let names = symByFileName.get(file);
      if (!names) symByFileName.set(file, (names = new Map()));
      if (!names.has(match[1])) names.set(match[1], id);
      let idsByName = symIdsByFileName.get(file);
      if (!idsByName) symIdsByFileName.set(file, (idsByName = new Map()));
      const ids = idsByName.get(match[1]) || [];
      ids.push(id);
      idsByName.set(match[1], ids);
      nodeById.set(id, node);
    }
  }
  // Bare-package imports (axios, node:fs, @scope/x) — the graph can't resolve them to a repo file, but
  // dependency analysis NEEDS them (unused/missing deps). Additive top-level array; nodes/links untouched.
  const externalImports = [];
  // SQL references (from .sql statements AND string literals in host-language code) collect during
  // pass 1 and resolve after both passes, once every schema object the repo declares is indexed.
  const sqlRefs = [];

  const resolvers = buildResolvers(repoDir, fileSet);          // aliases, go.mod, java index, href, selectors
  const { selectorIndex, htmlUsages } = resolvers;

  // ---- pass 1: files + symbols + imports (dispatched to each language module) ----
  // This runs on Electron's MAIN thread (the worker path hung web-tree-sitter's WASM in an Electron worker
  // thread → the infinite "BUILDING GRAPH…"). Parsing is synchronous CPU, so we YIELD the event loop every
  // few dozen files to keep the window responsive during a big-repo build, and SKIP giant/minified files
  // (a multi-MB single-line bundle can wedge the tree-sitter parse).
  let _parsed = 0;
  for (const abs of files) {
    const fileRel = rel(abs); const ext = extname(abs);
    const fileNode = { id: fileRel, label: fileRel.split("/").pop(), file_type: "code", source_file: fileRel, source_location: "L1" };
    if (isDataFile(fileRel) || isDocFile(fileRel)) {
      addNode(fileNode); perFileSymbols.set(fileRel, []); symByFileName.set(fileRel, new Map()); symIdsByFileName.set(fileRel, new Map()); continue;
    }  // config/infra/docs file-only node
    let code; try { code = readFileSync(abs, "utf8"); } catch { addNode(fileNode); continue; }
    addNode({ ...fileNode, physical_loc: physicalLineCount(code) });
    const grammar = EXT_LANG[ext]; const lang = LANGS[FAMILY[grammar]]; if (!lang || (!langs[grammar] && !lang.textOnly)) continue;
    // giant / generated / minified file → keep the file NODE but don't parse symbols (avoids a wedged parse)
    if (code.length > MAX_PARSE_BYTES) { perFileSymbols.set(fileRel, []); symByFileName.set(fileRel, new Map()); symIdsByFileName.set(fileRel, new Map()); continue; }
    if ((++_parsed % 24) === 0) await new Promise((r) => setImmediate(r)); // breathe: let the UI paint between chunks
    if (typeof opts.onParseFile === "function") opts.onParseFile(fileRel);
    let tree = null;   // textOnly languages (SQL) scan `code` directly — no grammar, no parse
    if (!lang.textOnly) {
      const parser = new Parser(); parser.setLanguage(langs[grammar]);
      try { tree = parser.parse(code); } catch { continue; }
    }

    const syms = []; const nameToId = new Map(); const nameToIds = new Map(); const moduleNameToId = new Map();
    const addSym = (name, line, callable, extra) => {
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return;
      const suffix = /^:[A-Za-z0-9_-]+$/.test(extra?.idSuffix || "") ? extra.idSuffix : "";
      const id = `${fileRel}#${name}@${line}${suffix}`; if (nodeIds.has(id)) return;
      const sourceNode = extra && extra.sourceNode;
      const selectionNode = extra && extra.selectionNode;
      const endLine = sourceNode?.endPosition ? sourceNode.endPosition.row + 1 : 0;
      let complexity = null;
      if (callable && sourceNode) {
        try { complexity = analyzeSyntaxComplexity(sourceNode, { family: lang.family, name }); }
        catch { complexity = null; }
      }
      addNode({
        id,
        label: callable ? `${name}()` : name,
        ...(callable ? { callable: true } : {}),
        file_type: "code",
        source_file: fileRel,
        source_location: `L${line}`,
        ...(endLine >= line ? { source_end: `L${endLine}` } : {}),
        ...(sourceNode?.startPosition && sourceNode?.endPosition ? {
          // web-tree-sitter Point columns are zero-based UTF-16 code-unit offsets. Keep the
          // declaration body range as well as the identifier selection so LSP reference
          // locations on a boundary line cannot be attributed to the wrong symbol.
          source_range: {
            start: {
              line: sourceNode.startPosition.row,
              character: sourceNode.startPosition.column,
            },
            end: {
              line: sourceNode.endPosition.row,
              character: sourceNode.endPosition.column,
            },
          },
        } : {}),
        ...(selectionNode?.startPosition && selectionNode?.endPosition ? {
          // web-tree-sitter's JavaScript Point columns are already zero-based UTF-16 code-unit
          // offsets, matching LSP positions exactly (including text before non-ASCII identifiers).
          selection_start: {
            line: selectionNode.startPosition.row,
            character: selectionNode.startPosition.column,
          },
          selection_end: {
            line: selectionNode.endPosition.row,
            character: selectionNode.endPosition.column,
          },
        } : {}),
        ...(complexity ? { complexity } : {}),
        ...(extra && extra.exported ? { exported: true } : {}),
        ...(extra && extra.testSurface ? { test_surface: true } : {}),
        ...(extra && extra.decorated ? { decorated: true } : {}),
        ...(extra && extra.symbolKind ? { symbol_kind: extra.symbolKind } : {}),
        ...(extra && extra.symbolSpace ? { symbol_space: extra.symbolSpace } : {}),
        ...(extra && extra.memberOf ? { member_of: extra.memberOf } : {}),
        ...(extra && extra.visibility ? { visibility: extra.visibility } : {}),
        ...(Number.isInteger(extra?.parameterCount) ? { parameter_count: extra.parameterCount } : {}),
        ...(extra?.receiverType ? { receiver_type: extra.receiverType } : {}),
        ...(extra?.returnType ? { return_type: extra.returnType } : {}),
        ...(extra?.fieldTypes && Object.keys(extra.fieldTypes).length ? { field_types: extra.fieldTypes } : {})
      });
      links.push({ source: fileRel, target: id, relation: "contains", confidence: "EXTRACTED" });
      syms.push({
        id,
        name,
        start: line,
        end: endLine >= line ? endLine : 0,
        ...(extra?.memberOf ? {memberOf: extra.memberOf} : {}),
        ...(extra?.symbolKind ? {symbolKind: extra.symbolKind} : {}),
        ...(extra?.symbolSpace ? {symbolSpace: extra.symbolSpace} : {}),
        ...(Number.isInteger(extra?.parameterCount) ? {parameterCount: extra.parameterCount} : {}),
      });
      if (!nameToId.has(name)) nameToId.set(name, id);
      const ids = nameToIds.get(name) || [];
      ids.push(id);
      nameToIds.set(name, ids);
      if (extra?.moduleDeclaration && !moduleNameToId.has(name)) moduleNameToId.set(name, id);
      return id;
    };
    const imports = new Map(); importedLocals.set(fileRel, imports);
    const recordJsExport = (record) => {
      if (!record) return;
      const records = jsExports.get(fileRel) || [];
      records.push(record);
      jsExports.set(fileRel, records);
    };
    const addImportEdge = (tgt, meta = {}) => {
      if (!tgt || tgt === fileRel) return;
      links.push({
        source: fileRel,
        target: tgt,
        relation: meta.relation || "imports",
        confidence: "EXTRACTED",
        provenance: meta.provenance || "RESOLVED",
        ...(typeof meta.typeOnly === "boolean" ? { typeOnly: meta.typeOnly } : {}),
        ...(meta.compileOnly === true ? { compileOnly: true } : {}),
        ...(meta.line ? { line: meta.line } : {}),
        ...(meta.specifier ? { specifier: meta.specifier } : {}),
      });
    };
    // rec: {spec, kind, line} bare-pkg import · {dynamic:true, spec?, target?} dynamic import marker
    // (target = internally-resolved dynamic import; suppresses false "unused file" in dep analysis) ·
    // {unresolved:true, spec} broken local import (relative or alias path that resolves to no file).
    const addExternalImport = (rec) => {
      if (!rec) return;
      if (rec.dynamic) { externalImports.push({ file: fileRel, spec: rec.spec || null, kind: rec.kind || "dynamic", dynamic: true, line: rec.line || 0, ...(rec.target ? { target: rec.target } : {}), ...(rec.typeOnly ? { typeOnly: true } : {}) }); return; }
      if (rec.unresolved) { externalImports.push({ file: fileRel, spec: rec.spec, kind: rec.kind || "esm", unresolved: true, line: rec.line || 0, ...(rec.typeOnly ? { typeOnly: true } : {}) }); return; }
      // non-npm extractors (go/python) classify their own specs and pass pkg/builtin/ecosystem precomputed
      if (rec.pkg) { externalImports.push({ file: fileRel, spec: rec.spec, pkg: rec.pkg, builtin: !!rec.builtin, kind: rec.kind || "import", line: rec.line || 0, ...(rec.ecosystem ? { ecosystem: rec.ecosystem } : {}), ...(rec.typeOnly ? { typeOnly: true } : {}) }); return; }
      const r = specToPkg(rec.spec);
      if (!r) return;
      externalImports.push({ file: fileRel, spec: rec.spec, pkg: r.pkg, builtin: !!r.builtin, kind: rec.kind || "esm", line: rec.line || 0, ...(rec.typeOnly ? { typeOnly: true } : {}) });
    };
    // Post-hoc export flag (export {a}, export default X, CJS module.exports) — declarations are flagged at addSym time.
    const markExported = (name) => { const id = moduleNameToId.get(name); const n = id && nodeById.get(id); if (n) n.exported = true; };

    try { lang.pass1({ grammar, tree, fileRel, code, caps, field, addSym, addNode, links, nodeIds, syms, nameToId, imports, addImportEdge, addExternalImport, markExported, recordJsExport, fileSet, sqlRefs, ...resolvers }); }
    catch (e) { /* one bad file never sinks the whole build */ void e; }
    // string-literal SQL in host-language code → schema reference candidates (resolved post-pass-2)
    if (!lang.textOnly && !lang.isWeb) try { scanEmbeddedSql(code, fileRel, sqlRefs); } catch { /* never sinks the build */ }

    syms.sort((a, b) => a.start - b.start);
    const eof = code.split("\n").length;
    for (let i = 0; i < syms.length; i++) {
      if (!syms[i].end || syms[i].end < syms[i].start) syms[i].end = i + 1 < syms.length ? syms[i + 1].start - 1 : eof;
    }
    perFileSymbols.set(fileRel, syms); symByFileName.set(fileRel, nameToId); symIdsByFileName.set(fileRel, nameToIds);
    if (tree) tree.delete();
  }

  // ---- pass 2: scope-aware calls + inheritance (Go package = whole dir → same-dir symbols share scope;
  // C# gets the same treatment: one folder ≈ one namespace by convention, and `using` names namespaces,
  // not files, so the folder map is the only reliable cross-file resolver) ----
  const {reExportOccurrences} = runInternalGraphPass2({
    files, rel, langs, caps, field, links, nodeById, perFileSymbols, symByFileName,
    symIdsByFileName, importedLocals, jsExports, resolvers,
  });
  // HTML class/id usage → the CSS file(s) defining that selector: file-level reference edges (deduped per pair).
  const htmlRefSeen = new Set();
  for (const u of htmlUsages) {
    const defs = selectorIndex.get(u.label); if (!defs) continue;
    for (const cssFile of defs) {
      if (cssFile === u.htmlFile) continue;
      const key = u.htmlFile + ">" + cssFile; if (htmlRefSeen.has(key)) continue; htmlRefSeen.add(key);
      links.push({ source: u.htmlFile, target: cssFile, relation: "references", confidence: "INFERRED" });
    }
  }
  // code/SQL → schema-object edges (tables/views/functions declared in .sql files)
  try { resolveSqlReferences({ sqlRefs, links, nodeById, perFileSymbols }); } catch { /* never sinks the build */ }

  // community = folder bucket (top 2 path parts) — deterministic, mirrors the folder-based module grouping the
  // app already uses (graph-builder-analysis.js). Populates Modules/community cards without a heavy clustering pass.
  assignDeterministicCommunities(nodes);
  stampEdgeProvenance(links);

  // extImportsV: bump when the externalImports schema/coverage changes (v3 = Java/Rust ecosystems) —
  // deps-engine rebuilds in memory when a saved graph is older than this.
  // edgeTypesV 2 adds language-neutral compile-only edges (currently Rust mod/use/re-export) on top
  // of v1's TypeScript typeOnly classification.
  return {
    nodes,
    links,
    externalImports,
    extImportsV: 3,
    edgeTypesV: 2,
    edgeProvenanceV: EDGE_PROVENANCE_V,
    complexityV: 2,
    physicalFileLocV: 1,
    repoBoundaryV: 1,
    barrelResolutionV: 1,
    reExportOccurrencesV: 1,
    symbolSpacesV: 1,
    extractorSchemaV: 7,   // v7 = Solidity + SQL indexing (schema objects, embedded-SQL edges)
    reExportOccurrences,
    jsExportRecords: Object.fromEntries([...jsExports.entries()].sort(([a], [b]) => a.localeCompare(b))),
    fileHashes: snapshot.fileHashes,
    fileExportSignatures: snapshot.fileExportSignatures,
    controlHashes: snapshot.controlHashes,
    graphRevision: snapshot.revision,
    ...(requestedFiles ? { incrementalScope: true } : {}),
  };
}

// Build + write graph.json to outPath (creating the dir). Returns { ok, nodes, links, graphJson }.
export async function writeInternalGraph(repoDir, outPath, opts = {}) {
  if (Array.isArray(opts.includeFiles)) throw new Error("refusing to write a scoped incremental graph as a complete graph");
  const graph = await buildInternalGraph(repoDir, opts);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(graph), "utf8");
  return { ok: true, nodes: graph.nodes.length, links: graph.links.length, graphJson: outPath };
}

export const INTERNAL_BUILDER_LANGS = GRAMMARS;
