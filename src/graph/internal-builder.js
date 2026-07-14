// Built-in, dependency-free code-graph builder: parses a repo with web-tree-sitter (WASM grammars,
// no Python/native tooling) and emits graph.json ({nodes: files+symbols, links:
// contains/imports/calls/inherits}) for the analysis pipeline.
//
// ARCHITECTURE: this file is the ORCHESTRATOR (file walk, parser lifecycle, per-repo resolvers, the two-pass
// loop, community). Each language lives in its OWN module under ./builder/lang-*.js and declares its grammars,
// file extensions, tree-sitter queries, and a pass1(ctx) extractor. To add/fix a language, edit only its module
// (or add one to LANG_MODULES).
//
// Loaded via createRequire: web-tree-sitter's ESM build throws on fs/promises in pure-ESM Node, but its CJS
// build works — and Electron main runs Node, so this needs no external runtime.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, extname, relative, dirname } from "node:path";
import { createRequire } from "node:module";
import LANG_JS from "./builder/lang-js.js";
import LANG_PY from "./builder/lang-python.js";
import LANG_GO from "./builder/lang-go.js";
import LANG_JAVA from "./builder/lang-java.js";
import LANG_HTML from "./builder/lang-html.js";
import LANG_CSS from "./builder/lang-css.js";
import { specToPkg } from "./builder/spec-pkg.js";
import { parseGoMod } from "../analysis/manifests.js";
import { analyzeSyntaxComplexity } from "../analysis/source-complexity.js";

const require = createRequire(import.meta.url);
const { Parser, Language, Query } = require("web-tree-sitter");

const WTS_DIR = dirname(require.resolve("web-tree-sitter"));
const NODE_MODULES = dirname(WTS_DIR);
const DEFAULT_RUNTIME_WASM = join(WTS_DIR, "tree-sitter.wasm");
const DEFAULT_WASM_DIR = join(NODE_MODULES, "tree-sitter-wasms", "out");

// ---- language registry (derived from the per-language modules) ----
const LANG_MODULES = [LANG_JS, LANG_PY, LANG_GO, LANG_JAVA, LANG_HTML, LANG_CSS];
const LANGS = {};                 // family -> module
const EXT_LANG = {};              // ext -> grammar
const FAMILY = {};                // grammar -> family
const GRAMMARS_SET = new Set();
for (const L of LANG_MODULES) {
  LANGS[L.family] = L;
  for (const g of L.grammars) GRAMMARS_SET.add(g);
  for (const [ext, g] of Object.entries(L.exts)) { EXT_LANG[ext] = g; FAMILY[g] = L.family; }
}
const GRAMMARS = [...GRAMMARS_SET];

// non-code files graph-builder also indexes as nodes (config/data/scripts) — added as file-only nodes (no symbols),
// so file counts + import targets (e.g. import cfg from "./x.json") match graph-builder.
const DATA_EXT = new Set([".json", ".sh", ".ps1", ".yaml", ".yml"]);   // config/data/scripts + k8s/skaffold/CI yaml
const INFRA_NAME = /(^|[\\/])(Dockerfile|Containerfile)(\.[\w.-]+)?$|\.dockerfile$/i;   // Dockerfile[.prod], *.dockerfile (no ext)
const isDataFile = (p) => DATA_EXT.has(extname(p)) || INFRA_NAME.test(String(p));
// Docs/prose (README, CLAUDE.md, AGENTS.md, docs/*.md, …) are indexed as file-only nodes so the GUI board can
// render them as NEUTRAL pillars (never dead-code scored) and wire the agent-instruction ones UP to the
// Claude Code / Codex node. AGENT_DOTFILE lets a few AI-agent instruction dotfiles past the dotfile skip below.
const DOC_EXT = new Set([".md", ".mdx", ".markdown", ".mdown", ".mkd", ".mkdn", ".rst", ".adoc", ".asciidoc"]);
const AGENT_DOTFILE = /^\.(cursorrules|windsurfrules|clinerules)$/i;
const isDocFile = (p) => DOC_EXT.has(extname(p)) || AGENT_DOTFILE.test(String(p).split(/[\\/]/).pop() || "");
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", "vendor", "weavatrix-graphs", "weavatrix-graphs", ".next", "out", "__pycache__", ".venv", "venv", "env", ".tox", "site-packages", ".mypy_cache", ".pytest_cache"]);
const MAX_PARSE_BYTES = 1_500_000;   // skip parsing files above this (minified bundles / generated blobs wedge tree-sitter)

let _ready = null;
const _langs = {};
async function ensureParser(opts = {}) {
  if (!_ready) _ready = Parser.init({ locateFile: () => opts.runtimeWasm || DEFAULT_RUNTIME_WASM });
  await _ready;
  const wasmDir = opts.wasmDir || DEFAULT_WASM_DIR;
  for (const g of GRAMMARS) if (!_langs[g]) { try { _langs[g] = await Language.load(join(wasmDir, `tree-sitter-${g}.wasm`)); } catch { _langs[g] = null; } }
  return _langs;
}

// Cycle-safe directory walk. statSync FOLLOWS symlinks/junctions, so a link pointing at an ancestor would
// otherwise recurse forever (a/b/link/b/link/…). We dedupe by REAL path (a visited dir is never re-entered)
// and cap depth as a backstop, so a symlink loop can't wedge the build.
function walk(dir, acc = [], seen = new Set(), depth = 0) {
  if (depth > 40) return acc;
  let real; try { real = realpathSync.native(dir); } catch { real = dir; }
  if (seen.has(real)) return acc;
  seen.add(real);
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    // dotfiles/dot-dirs are skipped EXCEPT a few AI-agent instruction dotfiles (.cursorrules etc.); dot-DIRS
    // never match AGENT_DOTFILE, so we still never recurse into them (.git/.github/.cursor stay out).
    if (name.startsWith(".") && !AGENT_DOTFILE.test(name)) continue;
    const full = join(dir, name);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, acc, seen, depth + 1);
    else { const e = extname(name); if ((EXT_LANG[e] && _langs[EXT_LANG[e]]) || isDataFile(name) || isDocFile(name)) acc.push(full); }
  }
  return acc;
}

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

// Per-repo resolution context shared by the language modules: JS/TS path-aliases + relative imports, Python
// dotted/relative modules, Go package dirs, Java class files, and web hrefs / the CSS selector index.
function buildResolvers(repoDir, fileSet) {
  // Go package = directory (resolved via go.mod module prefix); Java class = file (basename index).
  // go.mod requires also feed goSpecToPkg so external Go imports map to their declared module.
  let goModule = "";
  let goRequires = [];
  try {
    const gomod = parseGoMod(readFileSync(join(repoDir, "go.mod"), "utf8"));
    goModule = gomod.module;
    goRequires = gomod.requires.map((r) => r.path);
  } catch { /* no go.mod */ }
  const dirFiles = new Map();
  const filesByBase = new Map();
  for (const fr of fileSet) {
    const base = fr.split("/").pop();
    (filesByBase.get(base) || filesByBase.set(base, []).get(base)).push(fr);
    if (fr.endsWith(".go")) { const d = fr.includes("/") ? fr.slice(0, fr.lastIndexOf("/")) : ""; (dirFiles.get(d) || dirFiles.set(d, []).get(d)).push(fr); }
  }
  const resolveGoImport = (importPath) => {
    if (goModule && (importPath === goModule || importPath.startsWith(goModule + "/"))) {
      const d = importPath === goModule ? "" : importPath.slice(goModule.length + 1);
      if (dirFiles.has(d)) return d;
    }
    // a module DECLARED in go.mod is external by definition — never let the suffix fallback hijack it
    // into a same-named internal dir (pkg/errors/ vs github.com/pkg/errors → false "unused module")
    if (goRequires.some((r) => importPath === r || importPath.startsWith(r + "/"))) return null;
    const segs = importPath.split("/");
    for (const n of [Math.min(2, segs.length), 1]) { const suf = segs.slice(-n).join("/"); for (const d of dirFiles.keys()) if (d === suf || d.endsWith("/" + suf)) return d; }
    return null;
  };
  const resolveJavaImport = (parts) => {
    const full = parts.join("/") + ".java", base = parts[parts.length - 1] + ".java";
    const cands = filesByBase.get(base) || [];
    return cands.find((f) => f === full || f.endsWith("/" + full)) || cands[0] || null;
  };

  // path aliases (tsconfig compilerOptions.paths + vite/webpack alias) — without these, @components/@/etc
  // imports are missed and their targets look falsely DEAD.
  const aliasList = [];
  const addAlias = (a, t) => {
    a = String(a).replace(/\/\*$/, "").replace(/\/$/, "");
    t = String(t).replace(/\/\*$/, "").replace(/^\.\//, "").replace(/\/$/, "");
    if (a && t && !aliasList.some((x) => x.alias === a)) aliasList.push({ alias: a, target: t });
  };
  const jsBaseUrls = []; // tsconfig/jsconfig baseUrl roots — bare "components/Button" may be baseUrl-rooted, not an npm package
  for (const cfg of ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json", "jsconfig.json"]) {
    try {
      const raw = readFileSync(join(repoDir, cfg), "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1");
      const tj = JSON.parse(raw); const co = tj.compilerOptions || {}; const paths = co.paths || {};
      const baseUrl = String(co.baseUrl || ".").replace(/^\.\/?/, "").replace(/\/$/, "");
      if (co.baseUrl != null && !jsBaseUrls.includes(baseUrl)) jsBaseUrls.push(baseUrl);
      for (const [k, v] of Object.entries(paths)) { const t = Array.isArray(v) ? v[0] : v; if (t) addAlias(k, (baseUrl && !String(t).startsWith("./") ? baseUrl + "/" : "") + t); }
    } catch { /* no/invalid tsconfig */ }
  }
  for (const vc of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "webpack.config.js"]) {
    try { const src = readFileSync(join(repoDir, vc), "utf8"); for (const m of src.matchAll(/['"`]([^'"`]+)['"`]\s*:\s*path\.resolve\([^,]+,\s*['"`]([^'"`]+)['"`]\s*\)/g)) addAlias(m[1], m[2]); } catch { /* no bundler config */ }
  }
  aliasList.sort((a, b) => b.alias.length - a.alias.length);
  const resolveAlias = (spec) => { for (const { alias, target } of aliasList) { if (spec === alias) return target; if (spec.startsWith(alias + "/")) return target + spec.slice(alias.length); } return null; };

  const JS_EXTS = ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", "/index.js", "/index.ts", "/index.jsx", "/index.tsx"];
  const resolveJsImport = (fromRel, spec) => {
    if (!spec) return null;
    let base;
    if (spec.startsWith(".")) base = join(dirname(fromRel), spec).replace(/\\/g, "/").replace(/^\.\//, "");
    else {
      base = resolveAlias(spec);
      if (base == null) {
        // baseUrl-rooted internal import ("components/Button" with baseUrl:"src") — try before calling it an npm package
        for (const b of jsBaseUrls) {
          const root = (b ? b + "/" : "") + spec;
          for (const e of JS_EXTS) { const cand = (root + e).replace(/\/+/g, "/"); if (fileSet.has(cand)) return cand; }
        }
        return null;   // genuinely bare → npm package (stays unresolved here)
      }
    }
    for (const e of JS_EXTS) { const cand = (base + e).replace(/\/+/g, "/"); if (fileSet.has(cand)) return cand; }
    return null;
  };

  const resolvePyPath = (baseDir, parts) => {
    const p = [baseDir, ...parts].filter(Boolean).join("/").replace(/\/+/g, "/").replace(/^\.\//, "");
    // src-layout: absolute imports of the repo's own package live under src/ (PEP 517 convention)
    const cands = baseDir ? [p + ".py", p + "/__init__.py"] : [p + ".py", p + "/__init__.py", "src/" + p + ".py", "src/" + p + "/__init__.py"];
    for (const cand of cands) if (fileSet.has(cand)) return cand;
    return null;
  };
  const pyBaseDir = (fromRel, dots) => { let d = dots > 0 ? dirname(fromRel) : ""; for (let i = 1; i < dots; i++) d = dirname(d); return d === "." ? "" : d; };
  // top-level dirs holding .py files (incl. under src/) — PEP 420 namespace packages have no __init__.py,
  // so an absolute import of one resolves to no FILE; knowing the dir exists stops a false "external dep".
  const pyTopDirs = new Set();
  for (const fr of fileSet) {
    if (!fr.endsWith(".py") || !fr.includes("/")) continue;
    const seg = fr.split("/");
    pyTopDirs.add(seg[0]);
    if (seg[0] === "src" && seg.length > 2) pyTopDirs.add(seg[1]);
  }

  const selectorIndex = new Map();
  const htmlUsages = [];
  const resolveHref = (fromRel, href) => {
    if (!href) return null;
    const h = href.split(/[?#]/)[0].replace(/^\.\//, "");
    if (/^(https?:)?\/\//.test(h) || h.startsWith("data:") || h.startsWith("#") || h.startsWith("mailto:")) return null;
    const cand = h.startsWith("/") ? h.slice(1) : join(dirname(fromRel), h).replace(/\\/g, "/").replace(/^\.\//, "");
    return fileSet.has(cand) ? cand : null;
  };

  return { resolveJsImport, resolveAlias, resolvePyPath, pyBaseDir, pyTopDirs, resolveGoImport, dirFiles, resolveJavaImport, resolveHref, selectorIndex, htmlUsages, goModule, goRequires };
}

// Build + write graph.json to outPath (creating the dir). Returns { ok, nodes, links, graphJson }.
export async function writeInternalGraph(repoDir, outPath, opts = {}) {
  const graph = await buildInternalGraph(repoDir, opts);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(graph), "utf8");
  return { ok: true, nodes: graph.nodes.length, links: graph.links.length, graphJson: outPath };
}

export const INTERNAL_BUILDER_LANGS = GRAMMARS;
