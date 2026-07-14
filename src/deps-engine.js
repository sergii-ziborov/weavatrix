// Dependency-analysis SEAM — mirrors build-graph.js/mcp.js: one dispatcher the handlers call, switched by
// settings.depsEngine = "internal" (built-in analyzers over our graph, DEFAULT) | "external" (knip +
// depcheck + dependency-cruiser via npx, normalized to the same Finding shape). DEPS_SECURITY_PLAN §2.2.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pep503, parsePoetryLockDeps, parseUvLockDeps, parseDistMetadata } from "./analysis/manifests.js";
import { runInternalAudit } from "./analysis/internal-audit.js";
import { graphOutDirForRepo } from "./graph/layout.js";

export function activeDepsEngine(settings) {
  return settings && settings.depsEngine === "external" ? "external" : "internal";
}

// npm lockfile packages map (v2/v3) — the offline source for "dependencies of a dependency"
function readLockPackages(repoPath) {
  try { return JSON.parse(readFileSync(join(repoPath, "package-lock.json"), "utf8")).packages || null; } catch { return null; }
}

const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
// npm repository field -> browsable https URL ("git+https://... .git", "github:u/r", "u/r" shorthands)
function normRepoUrl(r) {
  let u = typeof r === "string" ? r : (r && r.url) || "";
  if (!u) return "";
  u = u.replace(/^git\+/, "").replace(/\.git(#.*)?$/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
  if (/^github:/.test(u)) u = "https://github.com/" + u.slice(7);
  else if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = "https://github.com/" + u;
  return /^https?:\/\//.test(u) ? u : "";
}

// Python dependency index (offline): poetry.lock / uv.lock per-package deps + venv site-packages
// *.dist-info METADATA (Requires-Dist). Map pep503(name) → { name, version, deps, repository }.
function readPyDepIndex(repoPath) {
  const idx = new Map();
  const put = (p) => { const k = pep503(p.name); if (!idx.has(k)) idx.set(k, p); };
  const pl = readText(join(repoPath, "poetry.lock"));
  if (pl) for (const p of parsePoetryLockDeps(pl)) put(p);
  const uv = readText(join(repoPath, "uv.lock"));
  if (uv) for (const p of parseUvLockDeps(uv)) put(p);
  for (const venv of ["venv", ".venv", "env"]) {
    const roots = [join(repoPath, venv, "Lib", "site-packages")]; // Windows layout
    try { for (const d of readdirSync(join(repoPath, venv, "lib"))) if (/^python/.test(d)) roots.push(join(repoPath, venv, "lib", d, "site-packages")); } catch { /* posix layout absent */ }
    for (const sp of roots) {
      let entries;
      try { entries = readdirSync(sp); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith(".dist-info")) continue;
        const meta = parseDistMetadata(readText(join(sp, e, "METADATA")) || "");
        if (meta.name) put(meta);
      }
    }
  }
  return idx;
}

// Deps + version + repo link of ONE package (Flow modal drill-down — any depth). npm sources first,
// then the python index; Go modules have no local metadata (pkg.go.dev covers them).
export function pkgDepsOf(repoPath, name) {
  const lockPkgs = readLockPackages(repoPath);
  const entry = lockPkgs && lockPkgs[`node_modules/${name}`];
  let pj = null;
  try { pj = JSON.parse(readFileSync(join(repoPath, "node_modules", name, "package.json"), "utf8")); } catch { /* not installed */ }
  if (entry || pj) {
    return {
      ok: true,
      ecosystem: "npm",
      version: (entry && entry.version) || (pj && pj.version) || "",
      deps: Object.keys((entry && entry.dependencies) || (pj && pj.dependencies) || {}),
      repository: pj ? normRepoUrl(pj.repository) || (typeof pj.homepage === "string" && /^https?:/.test(pj.homepage) ? pj.homepage.replace(/#.*$/, "") : "") : "",
    };
  }
  const py = readPyDepIndex(repoPath).get(pep503(name));
  if (py) return { ok: true, ecosystem: "PyPI", version: py.version || "", deps: py.deps || [], repository: py.repository || "" };
  return { ok: true, version: "", deps: [], missing: true }; // no offline metadata — not an error
}

// Graph loader shared by analyzeDeps + depsFlow. Prefers the saved graph.json when it carries
// CURRENT-format externalImports (extImportsV 2 = go/python ecosystems); else a deps-graph.json CACHE
// from a previous rebuild; else rebuilds AND caches — without the cache every run of a big repo paid
// a full multi-minute tree-sitter rebuild ("analysis runs forever"). graph.json stays untouched
// (the graph-builder toggle owns that file); Relations ↻ writing a v2 graph.json supersedes the cache.
async function loadDepsGraph(repoPath) {
  const dir = graphOutDirForRepo(repoPath);
  const tryRead = (file) => {
    try {
      const g = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (Array.isArray(g.externalImports) && (g.extImportsV || 1) >= 2) return g;
    } catch { /* absent/stale */ }
    return null;
  };
  let graph = tryRead("graph.json");
  if (graph) return { graph, graphSource: "graph.json" };
  graph = tryRead("deps-graph.json");
  if (graph) return { graph, graphSource: "deps-graph.json cache (rebuild via Relations ↻ to refresh)" };
  const { buildInternalGraph } = await import("./graph/internal-builder.js");
  graph = await buildInternalGraph(repoPath);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "deps-graph.json"), JSON.stringify(graph), "utf8");
  } catch { /* cache write is best-effort */ }
  return { graph, graphSource: "fresh build (cached as deps-graph.json)" };
}

export async function analyzeDeps(repoPath, { engine = "internal", settings = {} } = {}) {
  if (engine === "external") {
    const { runExternalDeps } = await import("./tools/deps-external.js");
    return runExternalDeps(repoPath);
  }
  let graph, graphSource;
  try {
    ({ graph, graphSource } = await loadDepsGraph(repoPath));
  } catch (error) {
    return { ok: false, error: `graph build failed: ${error.message}` };
  }
  const audit = await runInternalAudit(repoPath, {
    graph,
    rgPath: settings.rgPath || "",
    malwareExclusions: {
      urls: settings.malwareAllowUrls || "",
      packages: settings.malwareAllowPackages || "",
    },
  });
  return audit.ok ? { ...audit, graphSource } : audit;
}

// Aggregated "who imports what" for the Dependencies Flow sankey: repo top-level module → external
// package, weighted by import count. Same graph-loading gate as analyzeDeps; findings (from the saved
// deps run) tint packages with their worst severity.
export async function depsFlow(repoPath, { findings = [] } = {}) {
  let graph, graphSource;
  try {
    ({ graph, graphSource } = await loadDepsGraph(repoPath));
  } catch (error) {
    return { ok: false, error: `graph build failed: ${error.message}` };
  }
  const imports = (graph.externalImports || []).filter((e) => !e.unresolved && !e.dynamic && !e.builtin && e.pkg);
  // Left-column bucketing: top folder — but container dirs (src/, lib/, …) or any folder holding ≥60%
  // of all imports split one level deeper ("src" alone says nothing; "src/api" does).
  const CONTAINER_DIRS = new Set(["src", "lib", "app", "source", "packages", "services", "apps", "cmd", "internal", "pkg"]);
  const segWeight = new Map();
  for (const e of imports) { const s = String(e.file || "").split("/")[0]; segWeight.set(s, (segWeight.get(s) || 0) + 1); }
  const totalW = imports.length || 1;
  const splits = new Set([...segWeight].filter(([s, w]) => CONTAINER_DIRS.has(s) || w / totalW >= 0.6).map(([s]) => s));
  const bucketOf = (file) => {
    const parts = String(file || "").split("/");
    if (parts.length < 2) return "(root)";
    return splits.has(parts[0]) && parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
  };

  const links = new Map(); // "mod|pkg" → import count
  const pkgs = new Map();
  for (const e of imports) {
    const k = `${bucketOf(e.file)}|${e.pkg}`;
    links.set(k, (links.get(k) || 0) + 1);
    let p = pkgs.get(e.pkg);
    if (!p) pkgs.set(e.pkg, (p = { name: e.pkg, ecosystem: e.ecosystem || "npm", files: [] }));
    if (p.files.length < 30 && !p.files.includes(e.file)) p.files.push(e.file); // "imported by" list for the drill-down modal
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  for (const f of findings) {
    const p = f.package && pkgs.get(f.package);
    if (p && f.severity && (!p.severity || rank[f.severity] < rank[p.severity])) p.severity = f.severity;
  }

  // Dependencies OF dependencies (3rd sankey column) — offline: npm via the lockfile/node_modules,
  // Python via poetry.lock / uv.lock / venv dist-info metadata. Go has no local metadata (pkg.go.dev).
  const lockPkgs = readLockPackages(repoPath);
  const pyIdx = [...pkgs.values()].some((p) => p.ecosystem === "PyPI") ? readPyDepIndex(repoPath) : null;
  const transitive = [];
  const transSeverity = new Map();
  for (const f of findings) if (f.package && f.severity) { const prev = transSeverity.get(f.package); if (!prev || rank[f.severity] < rank[prev]) transSeverity.set(f.package, f.severity); }
  for (const p of pkgs.values()) {
    let deps = null;
    if (p.ecosystem === "npm") {
      deps = lockPkgs && lockPkgs[`node_modules/${p.name}`] ? Object.keys(lockPkgs[`node_modules/${p.name}`].dependencies || {}) : null;
      if (!deps) { try { deps = Object.keys(JSON.parse(readFileSync(join(repoPath, "node_modules", p.name, "package.json"), "utf8")).dependencies || {}); } catch { deps = null; } }
    } else if (p.ecosystem === "PyPI" && pyIdx) {
      deps = pyIdx.get(pep503(p.name))?.deps || null;
    }
    for (const d of deps || []) transitive.push({ pkg: p.name, dep: d, ...(transSeverity.has(d) ? { severity: transSeverity.get(d) } : {}) });
  }

  return {
    ok: true,
    graphSource,
    packages: [...pkgs.values()],
    links: [...links].map(([k, n]) => { const i = k.indexOf("|"); return { mod: k.slice(0, i), pkg: k.slice(i + 1), n }; }),
    transitive,
  };
}
