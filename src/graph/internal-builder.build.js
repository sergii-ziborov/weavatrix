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
import { addJavaReferences } from "./internal-builder.java.js";
import { assignDeterministicCommunities } from "./community.js";
import { resolveJsBarrels } from "./internal-builder.barrels.js";
import { snapshotRepository } from "./incremental-refresh.js";
import { EDGE_PROVENANCE_V, stampEdgeProvenance } from "./edge-provenance.js";

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
    addNode({ id: fileRel, label: fileRel.split("/").pop(), file_type: "code", source_file: fileRel, source_location: "L1" });
    if (isDataFile(fileRel) || isDocFile(fileRel)) { perFileSymbols.set(fileRel, []); symByFileName.set(fileRel, new Map()); symIdsByFileName.set(fileRel, new Map()); continue; }  // config/infra/docs file-only node
    const grammar = EXT_LANG[ext]; const lang = LANGS[FAMILY[grammar]]; if (!lang || !langs[grammar]) continue;
    let code; try { code = readFileSync(abs, "utf8"); } catch { continue; }
    // giant / generated / minified file → keep the file NODE but don't parse symbols (avoids a wedged parse)
    if (code.length > MAX_PARSE_BYTES) { perFileSymbols.set(fileRel, []); symByFileName.set(fileRel, new Map()); symIdsByFileName.set(fileRel, new Map()); continue; }
    if ((++_parsed % 24) === 0) await new Promise((r) => setImmediate(r)); // breathe: let the UI paint between chunks
    if (typeof opts.onParseFile === "function") opts.onParseFile(fileRel);
    const parser = new Parser(); parser.setLanguage(langs[grammar]);
    let tree; try { tree = parser.parse(code); } catch { continue; }

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
        ...(extra && extra.decorated ? { decorated: true } : {}),
        ...(extra && extra.symbolKind ? { symbol_kind: extra.symbolKind } : {}),
        ...(extra && extra.symbolSpace ? { symbol_space: extra.symbolSpace } : {}),
        ...(extra && extra.memberOf ? { member_of: extra.memberOf } : {}),
        ...(extra && extra.visibility ? { visibility: extra.visibility } : {})
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

    try { lang.pass1({ grammar, tree, fileRel, code, caps, field, addSym, addNode, links, nodeIds, syms, nameToId, imports, addImportEdge, addExternalImport, markExported, recordJsExport, fileSet, ...resolvers }); }
    catch (e) { /* one bad file never sinks the whole build */ void e; }

    syms.sort((a, b) => a.start - b.start);
    const eof = code.split("\n").length;
    for (let i = 0; i < syms.length; i++) {
      if (!syms[i].end || syms[i].end < syms[i].start) syms[i].end = i + 1 < syms.length ? syms[i + 1].start - 1 : eof;
    }
    perFileSymbols.set(fileRel, syms); symByFileName.set(fileRel, nameToId); symIdsByFileName.set(fileRel, nameToIds);
    tree.delete();
  }

  // ---- pass 2: scope-aware calls + inheritance (Go package = whole dir → same-dir symbols share scope;
  // C# gets the same treatment: one folder ≈ one namespace by convention, and `using` names namespaces,
  // not files, so the folder map is the only reliable cross-file resolver) ----
  const goDirSymbols = new Map();
  const sharesDirScope = (fr) => fr.endsWith(".go") || fr.endsWith(".cs") || fr.endsWith(".rs");
  for (const [fr, m] of symByFileName) {
    if (!sharesDirScope(fr)) continue;
    const d = fr.includes("/") ? fr.slice(0, fr.lastIndexOf("/")) : "";
    let dm = goDirSymbols.get(d); if (!dm) goDirSymbols.set(d, (dm = new Map()));
    for (const [n, id] of m) if (!dm.has(n)) dm.set(n, id);
  }
  const inferredSymbolSpace = (node) => {
    const explicit = String(node?.symbol_space || "");
    if (["value", "type", "both"].includes(explicit)) return explicit;
    const kind = String(node?.symbol_kind || "").toLowerCase();
    if (["interface", "type"].includes(kind)) return "type";
    if (["class", "enum"].includes(kind)) return "both";
    return "value";
  };
  const resolveNamedSymbol = (file, name, space = "value") => {
    const ids = symIdsByFileName.get(file)?.get(name) || [];
    const accepts = (id) => {
      const symbolSpace = inferredSymbolSpace(nodeById.get(id));
      return symbolSpace === "both" || symbolSpace === space;
    };
    const exact = ids.find((id) => inferredSymbolSpace(nodeById.get(id)) === space);
    return exact || ids.find(accepts) || null;
  };
  const { resolveNamespaceMember, reExportOccurrences } = resolveJsBarrels({
    jsExports, importedLocals, links,
    resolveSymbol: (file, name, typeOnly) => resolveNamedSymbol(file, name, typeOnly ? "type" : "value"),
  });
  // Exact source ranges can overlap (a named function nested inside another function). Attribute a call
  // to the innermost matching symbol, not whichever outer declaration happened to be added first.
  const enclosing = (fileRel, line) => {
    let best = null;
    for (const s of perFileSymbols.get(fileRel) || []) {
      if (line < s.start || line > s.end) continue;
      if (!best || s.start > best.start || (s.start === best.start && s.end < best.end)) best = s;
    }
    return best;
  };
  const resolveCall = (name, fileRel) => {
    const local = resolveNamedSymbol(fileRel, name, "value"); if (local) return local;
    if (sharesDirScope(fileRel)) { const d = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : ""; const dm = goDirSymbols.get(d); if (dm && dm.has(name)) return dm.get(name); }
    const imp = importedLocals.get(fileRel) && importedLocals.get(fileRel).get(name);
    if (imp && imp.targetFile) {
      const targetFile = imp.originFile || imp.targetFile;
      const importedName = imp.originName || imp.imported;
      return resolveNamedSymbol(targetFile, importedName, "value");
    }
    return null;
  };
  const javaTypeKinds = new Set(["class", "interface", "enum", "record", "annotation"]);
  const resolveJavaType = (name, fileRel) => {
    const imp = importedLocals.get(fileRel)?.get(name);
    if (imp?.targetFile) {
      const symbols = symByFileName.get(imp.targetFile);
      const target = symbols?.get(imp.imported) || symbols?.get(name);
      if (target && javaTypeKinds.has(nodeById.get(target)?.symbol_kind)) return target;
    }
    const target = symByFileName.get(fileRel)?.get(name);
    return target && javaTypeKinds.has(nodeById.get(target)?.symbol_kind) ? target : null;
  };
  for (const abs of files) {
    const fileRel = rel(abs); const grammar = EXT_LANG[extname(abs)]; if (!grammar) continue;
    const lang = LANGS[FAMILY[grammar]]; if (!lang || lang.isWeb || !langs[grammar]) continue;
    let code; try { code = readFileSync(abs, "utf8"); } catch { continue; }
    const parser = new Parser(); parser.setLanguage(langs[grammar]);
    let tree; try { tree = parser.parse(code); } catch { continue; }
    if (!lang.customCalls) for (const cap of caps(grammar, lang.calls, tree.rootNode)) {
      const caller = enclosing(fileRel, cap.node.startPosition.row + 1); if (!caller) continue;
      const target = resolveCall(cap.node.text, fileRel); if (!target || target === caller.id) continue;
      links.push({ source: caller.id, target, relation: "calls", confidence: "INFERRED", line: cap.node.startPosition.row + 1 });
    }
    if (typeof lang.pass2 === "function") {
      try {
        lang.pass2({
          grammar, tree, fileRel, code, caps, field, enclosing, links, nodeById,
          perFileSymbols, symByFileName, importedLocals, resolveCall,
        });
      } catch (e) { /* one language-specific resolver never sinks the graph */ void e; }
    }
    // qualified/selector calls (Go): `pkg.Func()` → the imported package's dir; else `receiver.Method()` → the
    // SAME package (heuristic by method name — connects lifecycle methods like peer.Enable() that need type info).
    if (lang.selectorCall) for (const cap of caps(grammar, lang.selectorCall, tree.rootNode)) {
      const sel = cap.node; const operand = field(sel, "operand"), fld = field(sel, "field");
      if (!operand || operand.type !== "identifier" || !fld) continue;
      const caller = enclosing(fileRel, sel.startPosition.row + 1); if (!caller) continue;
      const imp = importedLocals.get(fileRel) && importedLocals.get(fileRel).get(operand.text);
      const dir = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : "";
      const dm = goDirSymbols.get(imp && imp.targetDir ? imp.targetDir : dir);
      const target = dm && dm.get(fld.text);
      if (target && target !== caller.id) links.push({ source: caller.id, target, relation: "calls", confidence: "INFERRED", line: cap.node.startPosition.row + 1 });
    }
    for (const heritageSpec of lang.heritage || []) {
      const query = typeof heritageSpec === "string" ? heritageSpec : heritageSpec.query;
      const relation = typeof heritageSpec === "string" ? "inherits" : (heritageSpec.relation || "inherits");
      for (const cap of caps(grammar, query, tree.rootNode)) {
        const cls = enclosing(fileRel, cap.node.startPosition.row + 1); if (!cls) continue;
        const target = FAMILY[grammar] === "java" ? resolveJavaType(cap.node.text, fileRel) : resolveCall(cap.node.text, fileRel);
        if (target && target !== cls.id) links.push({ source: cls.id, target, relation, confidence: "INFERRED" });
      }
    }
    // JSX is a real symbol use even though it is not a call_expression. Resolve imported components to their
    // declaration so component fan-in and unused-export checks do not claim `<SettingsView />` is unreferenced.
    if (FAMILY[grammar] === "js") {
      // Namespace calls (`ui.run()`) need the member name before an export-star facade can be resolved.
      for (const cap of caps(grammar, `(call_expression function: (member_expression) @memberCall)`, tree.rootNode)) {
        const object = field(cap.node, "object"), property = field(cap.node, "property");
        if (!object || object.type !== "identifier" || !property) continue;
        const imp = importedLocals.get(fileRel)?.get(object.text);
        if (!imp || !["*", "default"].includes(imp.imported) || imp.typeOnly) continue;
        const origin = resolveNamespaceMember(fileRel, imp, property.text, "call");
        if (origin.status !== "resolved") continue;
        const target = resolveNamedSymbol(origin.origin.file, origin.origin.name, "value");
        const caller = enclosing(fileRel, cap.node.startPosition.row + 1);
        if (target && caller && target !== caller.id) links.push({ source: caller.id, target, relation: "calls", confidence: "INFERRED", line: cap.node.startPosition.row + 1 });
      }
      for (const cap of caps(grammar, `[
        (jsx_opening_element name: (_) @jsx)
        (jsx_self_closing_element name: (_) @jsx)
      ]`, tree.rootNode)) {
        const jsxName = cap.node.text;
        const parts = jsxName.split(".");
        const localName = parts[0];
        if (parts.length === 1 && !/^[A-Z_$]/.test(localName)) continue; // undotted lowercase tags are platform/intrinsic elements
        const imp = importedLocals.get(fileRel)?.get(localName);
        if (!imp || !imp.targetFile || imp.typeOnly) continue;
        let targetFile = imp.originFile || imp.targetFile;
        let importedName = imp.originName || imp.imported;
        if (imp.imported === "*" && parts.length > 1) {
          const origin = resolveNamespaceMember(fileRel, imp, parts[parts.length - 1], "jsx");
          if (origin.status === "resolved") { targetFile = origin.origin.file; importedName = origin.origin.name; }
        }
        const target = resolveNamedSymbol(targetFile, importedName, "value") || resolveNamedSymbol(targetFile, localName, "value");
        if (!target) continue;
        const owner = enclosing(fileRel, cap.node.startPosition.row + 1);
        links.push({ source: owner?.id || fileRel, target, relation: "references", confidence: "INFERRED", usage: "jsx", line: cap.node.startPosition.row + 1 });
      }
      // Type identifiers are a separate namespace in TypeScript. Resolve them to type/both-space
      // declarations without creating runtime calls or keeping a same-named value symbol alive.
      if (grammar !== "javascript") for (const cap of caps(grammar, `(type_identifier) @typeRef`, tree.rootNode)) {
        const name = cap.node.text;
        const imp = importedLocals.get(fileRel)?.get(name);
        const targetFile = imp?.originFile || imp?.targetFile || fileRel;
        const targetName = imp?.originName || imp?.imported || name;
        const target = resolveNamedSymbol(targetFile, targetName, "type");
        if (!target || String(target).startsWith(`${fileRel}#${name}@${cap.node.startPosition.row + 1}`)) continue;
        const owner = enclosing(fileRel, cap.node.startPosition.row + 1);
        const source = owner?.id || fileRel;
        if (source === target) continue;
        links.push({source, target, relation: "references", confidence: "EXTRACTED", provenance: "RESOLVED", typeOnly: true, line: cap.node.startPosition.row + 1, usage: "type"});
      }
    }
    // Go value references: a top-level const/var/type/func used BY NAME (bare `X`, or cross-package `pkg.X`) in
    // another file/scope → a `references` edge, so used-but-never-called symbols (message-type consts, etc.) are
    // not falsely DEAD. (Same-file usage is already covered by graph-builder-analysis localRefs.) Go-only for now.
    if (FAMILY[grammar] === "go") {
      const refSeen = new Set();
      const emitRef = (src, target) => { if (!target || target === src) return; const k = src + ">" + target; if (refSeen.has(k)) return; refSeen.add(k); links.push({ source: src, target, relation: "references", confidence: "INFERRED" }); };
      const dir = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : "";
      const dm = goDirSymbols.get(dir);
      for (const cap of caps(grammar, `[(identifier) (type_identifier)] @id`, tree.rootNode)) {   // type_identifier → struct/type usage
        const target = dm && dm.get(cap.node.text); if (!target || target.slice(0, target.indexOf("#")) === fileRel) continue;
        const caller = enclosing(fileRel, cap.node.startPosition.row + 1); emitRef(caller ? caller.id : fileRel, target);
      }
      for (const cap of caps(grammar, `(selector_expression) @sel`, tree.rootNode)) {
        const sel = cap.node; const operand = field(sel, "operand"), fld = field(sel, "field");
        if (!operand || operand.type !== "identifier" || !fld) continue;
        const imp = importedLocals.get(fileRel) && importedLocals.get(fileRel).get(operand.text); if (!imp || !imp.targetDir) continue;
        const tdm = goDirSymbols.get(imp.targetDir); const target = tdm && tdm.get(fld.text); if (!target) continue;
        const caller = enclosing(fileRel, sel.startPosition.row + 1); emitRef(caller ? caller.id : fileRel, target);
      }
    }
    if (FAMILY[grammar] === "java") {
      addJavaReferences({ grammar, tree, fileRel, caps, resolveJavaType, enclosing, links });
    }
    tree.delete();
  }

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

  // community = folder bucket (top 2 path parts) — deterministic, mirrors the folder-based module grouping the
  // app already uses (graph-builder-analysis.js). Populates Modules/community cards without a heavy clustering pass.
  assignDeterministicCommunities(nodes);
  stampEdgeProvenance(links);

  // extImportsV: bump when the externalImports schema/coverage changes (v2 = go/python ecosystems) —
  // deps-engine rebuilds in memory when a saved graph is older than this.
  // edgeTypesV 2 adds language-neutral compile-only edges (currently Rust mod/use/re-export) on top
  // of v1's TypeScript typeOnly classification.
  return {
    nodes,
    links,
    externalImports,
    extImportsV: 2,
    edgeTypesV: 2,
    edgeProvenanceV: EDGE_PROVENANCE_V,
    complexityV: 2,
    repoBoundaryV: 1,
    barrelResolutionV: 1,
    reExportOccurrencesV: 1,
    symbolSpacesV: 1,
    extractorSchemaV: 5,
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
