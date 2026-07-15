// Language registry, parser lifecycle (web-tree-sitter init + grammar loading), and the cycle-safe
// repo file walk for the internal graph builder (split from internal-builder.js — see its doc comment).
//
// Loaded via createRequire: web-tree-sitter's ESM build throws on fs/promises in pure-ESM Node, but its CJS
// build works — and Electron main runs Node, so this needs no external runtime.
import { readdirSync, statSync, realpathSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import LANG_JS from "./builder/lang-js.js";
import LANG_PY from "./builder/lang-python.js";
import LANG_GO from "./builder/lang-go.js";
import LANG_JAVA from "./builder/lang-java.js";
import LANG_CSHARP from "./builder/lang-csharp.js";
import LANG_RUST from "./builder/lang-rust.js";
import LANG_HTML from "./builder/lang-html.js";
import LANG_CSS from "./builder/lang-css.js";

const require = createRequire(import.meta.url);
const { Parser, Language, Query } = require("web-tree-sitter");

const WTS_DIR = dirname(require.resolve("web-tree-sitter"));
const NODE_MODULES = dirname(WTS_DIR);
const DEFAULT_RUNTIME_WASM = join(WTS_DIR, "tree-sitter.wasm");
const DEFAULT_WASM_DIR = join(NODE_MODULES, "tree-sitter-wasms", "out");

// ---- language registry (derived from the per-language modules) ----
const LANG_MODULES = [LANG_JS, LANG_PY, LANG_GO, LANG_JAVA, LANG_CSHARP, LANG_RUST, LANG_HTML, LANG_CSS];
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

export { Parser, Query, GRAMMARS, LANGS, EXT_LANG, FAMILY, isDataFile, isDocFile, MAX_PARSE_BYTES, ensureParser, walk };
