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

// Parse a repo directory into a graph-builder-compatible { nodes, links } graph.
export async function buildInternalGraph(repoDir, opts = {}) {
  const langs = await ensureParser(opts);
  const qc = new Map();
  const q = (grammar, src) => { const k = grammar + ":" + src; if (qc.has(k)) return qc.get(k); let x = null; try { x = new Query(langs[grammar], src); } catch { x = null; } qc.set(k, x); return x; };
  const caps = (grammar, src, root) => { const query = src && q(grammar, src); return query ? query.captures(root) : []; };
  const field = (n, f) => (n && n.childForFieldName ? n.childForFieldName(f) : null);

  const files = walk(repoDir);
  const rel = (p) => relative(repoDir, p).replace(/\\/g, "/");
  const fileSet = new Set(files.map(rel));
  const nodes = []; const links = []; const nodeIds = new Set(); const nodeById = new Map();
  const addNode = (n) => { if (!nodeIds.has(n.id)) { nodeIds.add(n.id); nodes.push(n); nodeById.set(n.id, n); } };
  const perFileSymbols = new Map();
  const symByFileName = new Map();
  const importedLocals = new Map();
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
    if (isDataFile(fileRel) || isDocFile(fileRel)) { perFileSymbols.set(fileRel, []); symByFileName.set(fileRel, new Map()); continue; }  // config/infra/docs file-only node
    const grammar = EXT_LANG[ext]; const lang = LANGS[FAMILY[grammar]]; if (!lang || !langs[grammar]) continue;
    let code; try { code = readFileSync(abs, "utf8"); } catch { continue; }
    // giant / generated / minified file → keep the file NODE but don't parse symbols (avoids a wedged parse)
    if (code.length > MAX_PARSE_BYTES) { perFileSymbols.set(fileRel, []); symByFileName.set(fileRel, new Map()); continue; }
    if ((++_parsed % 24) === 0) await new Promise((r) => setImmediate(r)); // breathe: let the UI paint between chunks
    const parser = new Parser(); parser.setLanguage(langs[grammar]);
    let tree; try { tree = parser.parse(code); } catch { continue; }

    const syms = []; const nameToId = new Map();
    const addSym = (name, line, callable, extra) => {
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return;
      const id = `${fileRel}#${name}@${line}`; if (nodeIds.has(id)) return;
      const sourceNode = extra && extra.sourceNode;
      const endLine = sourceNode?.endPosition ? sourceNode.endPosition.row + 1 : 0;
      let complexity = null;
      if (callable && sourceNode) {
        try { complexity = analyzeSyntaxComplexity(sourceNode, { family: lang.family, name }); }
        catch { complexity = null; }
      }
      addNode({
        id,
        label: callable ? `${name}()` : name,
        file_type: "code",
        source_file: fileRel,
        source_location: `L${line}`,
        ...(endLine >= line ? { source_end: `L${endLine}` } : {}),
        ...(complexity ? { complexity } : {}),
        ...(extra && extra.exported ? { exported: true } : {}),
        ...(extra && extra.decorated ? { decorated: true } : {})
      });
      links.push({ source: fileRel, target: id, relation: "contains", confidence: "EXTRACTED" });
      syms.push({ id, name, start: line, end: endLine >= line ? endLine : 0 }); if (!nameToId.has(name)) nameToId.set(name, id);
    };
    const imports = new Map(); importedLocals.set(fileRel, imports);
    const addImportEdge = (tgt) => { if (tgt && tgt !== fileRel) links.push({ source: fileRel, target: tgt, relation: "imports", confidence: "EXTRACTED" }); };
    // rec: {spec, kind, line} bare-pkg import · {dynamic:true, spec?, target?} dynamic import marker
    // (target = internally-resolved dynamic import; suppresses false "unused file" in dep analysis) ·
    // {unresolved:true, spec} broken local import (relative or alias path that resolves to no file).
    const addExternalImport = (rec) => {
      if (!rec) return;
      if (rec.dynamic) { externalImports.push({ file: fileRel, spec: rec.spec || null, kind: rec.kind || "dynamic", dynamic: true, line: rec.line || 0, ...(rec.target ? { target: rec.target } : {}) }); return; }
      if (rec.unresolved) { externalImports.push({ file: fileRel, spec: rec.spec, kind: rec.kind || "esm", unresolved: true, line: rec.line || 0 }); return; }
      // non-npm extractors (go/python) classify their own specs and pass pkg/builtin/ecosystem precomputed
      if (rec.pkg) { externalImports.push({ file: fileRel, spec: rec.spec, pkg: rec.pkg, builtin: !!rec.builtin, kind: rec.kind || "import", line: rec.line || 0, ...(rec.ecosystem ? { ecosystem: rec.ecosystem } : {}) }); return; }
      const r = specToPkg(rec.spec);
      if (!r) return;
      externalImports.push({ file: fileRel, spec: rec.spec, pkg: r.pkg, builtin: !!r.builtin, kind: rec.kind || "esm", line: rec.line || 0 });
    };
    // Post-hoc export flag (export {a}, export default X, CJS module.exports) — declarations are flagged at addSym time.
    const markExported = (name) => { const id = nameToId.get(name); const n = id && nodeById.get(id); if (n) n.exported = true; };

    try { lang.pass1({ grammar, tree, fileRel, code, caps, field, addSym, addNode, links, nodeIds, syms, nameToId, imports, addImportEdge, addExternalImport, markExported, fileSet, ...resolvers }); }
    catch (e) { /* one bad file never sinks the whole build */ void e; }

    syms.sort((a, b) => a.start - b.start);
    const eof = code.split("\n").length;
    for (let i = 0; i < syms.length; i++) {
      if (!syms[i].end || syms[i].end < syms[i].start) syms[i].end = i + 1 < syms.length ? syms[i + 1].start - 1 : eof;
    }
    perFileSymbols.set(fileRel, syms); symByFileName.set(fileRel, nameToId);
    tree.delete();
  }

  // ---- pass 2: scope-aware calls + inheritance (Go package = whole dir → same-dir symbols share scope) ----
  const goDirSymbols = new Map();
  for (const [fr, m] of symByFileName) {
    if (!fr.endsWith(".go")) continue;
    const d = fr.includes("/") ? fr.slice(0, fr.lastIndexOf("/")) : "";
    let dm = goDirSymbols.get(d); if (!dm) goDirSymbols.set(d, (dm = new Map()));
    for (const [n, id] of m) if (!dm.has(n)) dm.set(n, id);
  }
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
    const local = symByFileName.get(fileRel); if (local && local.has(name)) return local.get(name);
    if (fileRel.endsWith(".go")) { const d = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : ""; const dm = goDirSymbols.get(d); if (dm && dm.has(name)) return dm.get(name); }
    const imp = importedLocals.get(fileRel) && importedLocals.get(fileRel).get(name);
    if (imp && imp.targetFile) { const tf = symByFileName.get(imp.targetFile); if (tf && tf.has(imp.imported)) return tf.get(imp.imported); }
    return null;
  };
  for (const abs of files) {
    const fileRel = rel(abs); const grammar = EXT_LANG[extname(abs)]; if (!grammar) continue;
    const lang = LANGS[FAMILY[grammar]]; if (!lang || lang.isWeb || !langs[grammar]) continue;
    let code; try { code = readFileSync(abs, "utf8"); } catch { continue; }
    const parser = new Parser(); parser.setLanguage(langs[grammar]);
    let tree; try { tree = parser.parse(code); } catch { continue; }
    for (const cap of caps(grammar, lang.calls, tree.rootNode)) {
      const caller = enclosing(fileRel, cap.node.startPosition.row + 1); if (!caller) continue;
      const target = resolveCall(cap.node.text, fileRel); if (!target || target === caller.id) continue;
      links.push({ source: caller.id, target, relation: "calls", confidence: "INFERRED" });
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
      if (target && target !== caller.id) links.push({ source: caller.id, target, relation: "calls", confidence: "INFERRED" });
    }
    for (const heritageSrc of lang.heritage || []) for (const cap of caps(grammar, heritageSrc, tree.rootNode)) {
      const cls = enclosing(fileRel, cap.node.startPosition.row + 1); if (!cls) continue;
      const target = resolveCall(cap.node.text, fileRel);
      if (target && target !== cls.id) links.push({ source: cls.id, target, relation: "inherits", confidence: "INFERRED" });
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
  const folderOf = (f) => { const d = String(f || "").split("/").filter(Boolean).slice(0, -1); return d.length ? d.slice(0, 2).join("/") : "(root)"; };
  const commOf = new Map(); let commSeq = 0;
  for (const n of nodes) { const fo = folderOf(n.source_file); if (!commOf.has(fo)) commOf.set(fo, commSeq++); n.community = commOf.get(fo); }

  // extImportsV: bump when the externalImports schema/coverage changes (v2 = go/python ecosystems) —
  // deps-engine rebuilds in memory when a saved graph is older than this.
  return { nodes, links, externalImports, extImportsV: 2, complexityV: 1 };
}

// Build + write graph.json to outPath (creating the dir). Returns { ok, nodes, links, graphJson }.
export async function writeInternalGraph(repoDir, outPath, opts = {}) {
  const graph = await buildInternalGraph(repoDir, opts);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(graph), "utf8");
  return { ok: true, nodes: graph.nodes.length, links: graph.links.length, graphJson: outPath };
}

export const INTERNAL_BUILDER_LANGS = GRAMMARS;
