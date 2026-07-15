// Per-repo resolution context shared by the language modules: JS/TS path-aliases + relative imports, Python
// dotted/relative modules, Go package dirs, Java class files, and web hrefs / the CSS selector index.
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
      const raw = readLocal(cfg).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1");
      const tj = JSON.parse(raw); const co = tj.compilerOptions || {}; const paths = co.paths || {};
      const baseUrl = String(co.baseUrl || ".").replace(/^\.\/?/, "").replace(/\/$/, "");
      if (co.baseUrl != null && !jsBaseUrls.includes(baseUrl)) jsBaseUrls.push(baseUrl);
      for (const [k, v] of Object.entries(paths)) { const t = Array.isArray(v) ? v[0] : v; if (t) addAlias(k, (baseUrl && !String(t).startsWith("./") ? baseUrl + "/" : "") + t); }
    } catch { /* no/invalid tsconfig */ }
  }
  for (const vc of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "webpack.config.js"]) {
    try { const src = readLocal(vc); for (const m of src.matchAll(/['"`]([^'"`]+)['"`]\s*:\s*path\.resolve\([^,]+,\s*['"`]([^'"`]+)['"`]\s*\)/g)) addAlias(m[1], m[2]); } catch { /* no bundler config */ }
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
