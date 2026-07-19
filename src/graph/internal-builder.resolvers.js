// Per-repo resolution context shared by the language modules: JS/TS path-aliases + relative imports, Python
// dotted/relative modules, Go package dirs, Rust crate/module paths, Java class files, and web hrefs /
// the CSS selector index.
// (Split from internal-builder.js — see its doc comment for the overall architecture.)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseGoMod } from "../analysis/manifests.js";
import { createRepoBoundary } from "../repo-path.js";
import { createRustResolvers } from "./resolvers/rust.js";

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

  const { resolveRustMod, resolveRustPath } = createRustResolvers(fileSet);

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
  const resolveJsBase = (base) => {
    for (const extension of JS_EXTS) {
      const candidate = (base + extension).replace(/\/+/g, "/");
      if (fileSet.has(candidate)) return candidate;
    }
    // TypeScript NodeNext source commonly imports the emitted extension (`./http.js`) while the
    // repository contains `http.ts`/`http.tsx`. Exact runtime files win above; a source counterpart
    // is accepted only when unique so same-basename ambiguity is never guessed.
    const sourceCandidates = [];
    if (/\.js$/i.test(base)) sourceCandidates.push(base.replace(/\.js$/i, ".ts"), base.replace(/\.js$/i, ".tsx"));
    else if (/\.jsx$/i.test(base)) sourceCandidates.push(base.replace(/\.jsx$/i, ".tsx"));
    const existing = [...new Set(sourceCandidates.map((candidate) => candidate.replace(/\/+/g, "/")))]
      .filter((candidate) => fileSet.has(candidate));
    return existing.length === 1 ? existing[0] : null;
  };
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
          const resolved = resolveJsBase(root);
          if (resolved) return resolved;
        }
        return null;   // genuinely bare → npm package (stays unresolved here)
      }
    }
    return resolveJsBase(base);
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
