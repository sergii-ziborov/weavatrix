// Per-repo resolution context shared by the language modules: JS/TS path-aliases + relative imports, Python
// dotted/relative modules, Go package dirs, Rust crate/module paths, Java class files, and web hrefs /
// the CSS selector index.
// (Split from internal-builder.js — see its doc comment for the overall architecture.)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseGoMod } from "../analysis/manifests.js";
import { createRepoBoundary } from "../repo-path.js";

export function buildResolvers(repoDir, fileSet) {
  const boundary = createRepoBoundary(repoDir);
  const readLocal = (relativePath) => {
    const resolved = boundary.resolve(relativePath);
    if (!resolved.ok) throw new Error("resolver input is outside the repository");
    return readFileSync(resolved.path, "utf8");
  };
  // Go package = directory (resolved via go.mod module prefix); Java class = file (basename index).
  // go.mod requires also feed goSpecToPkg so external Go imports map to their declared module.
  let goModule = "";
  let goRequires = [];
  try {
    const gomod = parseGoMod(readLocal("go.mod"));
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

  // Rust modules are files, but their paths are logical rather than simple source-relative imports:
  // `foo.rs` owns children below `foo/`, while lib.rs/main.rs/mod.rs own siblings. Keep the resolver
  // filesystem-only and crate-local: Cargo/external dependencies belong to dependency analysis, not to
  // the internal module graph.
  const cleanRustRel = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "").replace(/^\.$/, "");
  const rustDir = (p) => { p = cleanRustRel(p); const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  const rustBase = (p) => { p = cleanRustRel(p); const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); };
  const rustJoin = (...parts) => cleanRustRel(join(...parts.filter((x) => x != null && x !== "")));
  const rustFiles = new Set([...fileSet].filter((fr) => fr.endsWith(".rs")));
  const rustRoots = new Map();
  for (const fr of rustFiles) {
    const base = rustBase(fr);
    if (base !== "lib.rs" && base !== "main.rs") continue;
    const dir = rustDir(fr);
    let root = rustRoots.get(dir);
    if (!root) rustRoots.set(dir, (root = { base: dir, lib: null, main: null }));
    root[base === "lib.rs" ? "lib" : "main"] = fr;
  }
  const rustRootList = [...rustRoots.values()].sort((a, b) => b.base.length - a.base.length);
  const rustContext = (fromRel) => {
    fromRel = cleanRustRel(fromRel);
    const base = rustBase(fromRel);
    const dir = rustDir(fromRel);
    if (base === "lib.rs" || base === "main.rs") return { base: dir, rootFile: fromRel };

    // Cargo treats direct files in these conventional folders as independent crate roots. This only
    // affects paths originating in the root file itself; nested module ownership still comes from mod/use.
    if (/^(?:bin|examples|tests|benches)$/.test(rustBase(dir))) return { base: dir, rootFile: fromRel };
    for (const root of rustRootList) {
      if (!root.base || fromRel.startsWith(root.base + "/")) return { base: root.base, rootFile: root.lib || root.main };
    }
    return { base: dir, rootFile: fromRel };
  };
  const rustModuleBase = (fromRel) => {
    const ctx = rustContext(fromRel);
    if (ctx.rootFile === cleanRustRel(fromRel)) return rustDir(fromRel);
    const name = rustBase(fromRel);
    if (name === "lib.rs" || name === "main.rs" || name === "mod.rs") return rustDir(fromRel);
    return rustJoin(rustDir(fromRel), name.replace(/\.rs$/, ""));
  };
  const rustInlineBase = (fromRel, inlineModules = []) => {
    let base = rustModuleBase(fromRel);
    for (let i = 0; i < inlineModules.length; i++) {
      const mod = inlineModules[i] || {};
      if (mod.path) {
        // Rust Reference: a path attribute on the first inline module is relative to the source file's
        // directory; nested attributes are relative to their containing module's search directory.
        const parent = i === 0 ? rustDir(fromRel) : base;
        base = rustJoin(parent, mod.path);
      } else base = rustJoin(base, mod.name);
    }
    return base;
  };
  const rustModuleFile = (moduleBase, ctx) => {
    moduleBase = cleanRustRel(moduleBase);
    if (moduleBase === cleanRustRel(ctx.base) && ctx.rootFile && rustFiles.has(ctx.rootFile)) return ctx.rootFile;
    const flat = moduleBase + ".rs";
    if (rustFiles.has(flat)) return flat;
    const legacy = rustJoin(moduleBase, "mod.rs");
    return rustFiles.has(legacy) ? legacy : null;
  };
  const resolveRustMod = (fromRel, name, { inlineModules = [], explicitPath = "" } = {}) => {
    fromRel = cleanRustRel(fromRel);
    if (explicitPath) {
      const parent = inlineModules.length ? rustInlineBase(fromRel, inlineModules) : rustDir(fromRel);
      const target = rustJoin(parent, explicitPath);
      return rustFiles.has(target) ? target : null;
    }
    const targetBase = rustJoin(rustInlineBase(fromRel, inlineModules), String(name || "").replace(/^r#/, ""));
    return rustModuleFile(targetBase, rustContext(fromRel));
  };
  const resolveRustPath = (fromRel, rawSegments, { inlineModules = [], unqualified = true } = {}) => {
    fromRel = cleanRustRel(fromRel);
    const segments = (Array.isArray(rawSegments) ? rawSegments : String(rawSegments || "").split("::"))
      .map((s) => String(s).trim().replace(/^r#/, "")).filter(Boolean);
    if (!segments.length) return null;
    const ctx = rustContext(fromRel);
    const current = rustInlineBase(fromRel, inlineModules);
    let rest = [...segments];
    const starts = [];
    let anchored = false;
    if (rest[0] === "crate") { anchored = true; rest.shift(); starts.push(ctx.base); }
    else if (rest[0] === "self") { anchored = true; rest.shift(); starts.push(current); }
    else if (rest[0] === "super") {
      anchored = true;
      let base = current;
      while (rest[0] === "super") { rest.shift(); base = rustDir(base); }
      if (ctx.base && base !== ctx.base && !base.startsWith(ctx.base + "/")) return null;
      starts.push(base);
    } else if (unqualified) {
      // Rust 2018 resolves a bare use path from the crate root/external prelude. Prefer an internal root
      // module, then allow a lexically-local module for qualified expressions in nested modules.
      starts.push(ctx.base);
      if (current !== ctx.base) starts.push(current);
    } else return null;

    for (const start of starts) {
      const min = anchored ? 0 : 1; // never reinterpret an unresolved external `serde::X` as the crate root
      for (let used = rest.length; used >= min; used--) {
        const target = rustModuleFile(rustJoin(start, ...rest.slice(0, used)), ctx);
        if (target) return { targetFile: target, consumed: segments.length - rest.length + used, remaining: rest.slice(used), anchored };
      }
    }
    return null;
  };

  // Path aliases (tsconfig compilerOptions.paths + vite/webpack alias) are scoped to their config folder.
  // Without nearest-config resolution, a monorepo's root `@/*` can hijack the same alias in web/.
  const aliasContexts = new Map();
  const cleanRel = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "").replace(/^\.$/, "");
  const contextFor = (dir) => {
    dir = cleanRel(dir);
    let ctx = aliasContexts.get(dir);
    if (!ctx) aliasContexts.set(dir, (ctx = { dir, aliases: [], baseUrls: [] }));
    return ctx;
  };
  const addAlias = (ctx, a, t) => {
    a = String(a).replace(/\/\*$/, "").replace(/\/$/, "");
    t = cleanRel(String(t)).replace(/\/\*$/, "");
    if (a && t && !ctx.aliases.some((x) => x.alias === a)) ctx.aliases.push({ alias: a, target: t });
  };
  const parseJsonc = (raw) => {
    // Regex comment stripping corrupts perfectly valid path strings such as `"@/*"` followed later by
    // `"**/*.ts"`. Strip comments/trailing commas only while outside JSON strings.
    raw = String(raw).replace(/^\uFEFF/, "");
    let clean = ""; let inString = false; let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i], next = raw[i + 1];
      if (inString) {
        clean += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; clean += ch; continue; }
      if (ch === "/" && next === "/") { while (i < raw.length && raw[i] !== "\n") i++; clean += "\n"; continue; }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) { if (raw[i] === "\n") clean += "\n"; i++; }
        i++;
        continue;
      }
      clean += ch;
    }
    let withoutTrailing = ""; inString = false; escaped = false;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (inString) {
        withoutTrailing += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; withoutTrailing += ch; continue; }
      if (ch === ",") {
        let j = i + 1; while (/\s/.test(clean[j] || "")) j++;
        if (clean[j] === "}" || clean[j] === "]") continue;
      }
      withoutTrailing += ch;
    }
    return JSON.parse(withoutTrailing);
  };
  const configRank = (fr) => /(^|\/)tsconfig\.json$/i.test(fr) ? 0 : /(^|\/)jsconfig\.json$/i.test(fr) ? 1 : 2;
  const configFiles = [...fileSet]
    .filter((fr) => /(^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i.test(fr))
    .sort((a, b) => dirname(a).localeCompare(dirname(b)) || configRank(a) - configRank(b) || a.localeCompare(b));
  for (const cfg of configFiles) {
    try {
      const tj = parseJsonc(readLocal(cfg)); const co = tj.compilerOptions || {}; const paths = co.paths || {};
      const cfgDir = cleanRel(dirname(cfg)); const ctx = contextFor(cfgDir);
      const baseRoot = cleanRel(join(cfgDir || ".", String(co.baseUrl || ".")));
      if (co.baseUrl != null && !ctx.baseUrls.includes(baseRoot)) ctx.baseUrls.push(baseRoot);
      for (const [k, v] of Object.entries(paths)) {
        const t = Array.isArray(v) ? v[0] : v;
        if (t) addAlias(ctx, k, join(baseRoot || ".", String(t)));
      }
    } catch { /* no/invalid tsconfig */ }
  }
  for (const vc of [...fileSet].filter((fr) => /(^|\/)(?:vite\.config\.(?:ts|js|mjs)|webpack\.config\.js)$/.test(fr))) {
    try {
      const cfgDir = cleanRel(dirname(vc)); const ctx = contextFor(cfgDir); const src = readLocal(vc);
      for (const m of src.matchAll(/['"`]([^'"`]+)['"`]\s*:\s*path\.resolve\([^,]+,\s*['"`]([^'"`]+)['"`]\s*\)/g)) addAlias(ctx, m[1], join(cfgDir || ".", m[2]));
    } catch { /* no/invalid bundler config */ }
  }
  for (const ctx of aliasContexts.values()) ctx.aliases.sort((a, b) => b.alias.length - a.alias.length);
  const contextsForFile = (fromRel) => [...aliasContexts.values()]
    .filter((ctx) => !ctx.dir || fromRel === ctx.dir || fromRel.startsWith(ctx.dir + "/"))
    .sort((a, b) => b.dir.length - a.dir.length);
  const resolveAlias = (fromRel, spec) => {
    if (spec === undefined) { spec = fromRel; fromRel = ""; }
    for (const ctx of contextsForFile(fromRel)) for (const { alias, target } of ctx.aliases) {
      if (spec === alias) return target;
      if (spec.startsWith(alias + "/")) return target + spec.slice(alias.length);
    }
    return null;
  };

  const JS_EXTS = ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", "/index.js", "/index.ts", "/index.jsx", "/index.tsx"];
  const resolveJsImport = (fromRel, spec) => {
    if (!spec) return null;
    let base;
    if (spec.startsWith(".")) base = join(dirname(fromRel), spec).replace(/\\/g, "/").replace(/^\.\//, "");
    else {
      base = resolveAlias(fromRel, spec);
      if (base == null) {
        // baseUrl-rooted internal import ("components/Button" with baseUrl:"src") — try before calling it an npm package
        for (const ctx of contextsForFile(fromRel)) for (const b of ctx.baseUrls) {
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

  return { resolveJsImport, resolveAlias, resolvePyPath, pyBaseDir, pyTopDirs, resolveGoImport, dirFiles, resolveRustMod, resolveRustPath, resolveJavaImport, resolveHref, selectorIndex, htmlUsages, goModule, goRequires };
}
