// internal-audit.collect.js — filesystem collection helpers for the internal audit: source/config
// text gathering, workspace package names, and the Python manifest reader. Split from internal-audit.js.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseRequirementsNames, parsePyprojectDeps, parsePipfileDeps } from "./manifests.js";
import { createRepoBoundary } from "../repo-path.js";

export const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
export const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
export const readRepoText = (boundary, relativePath) => {
  const resolved = boundary.resolve(relativePath);
  return resolved.ok ? readText(resolved.path) : null;
};
export const readRepoJson = (boundary, relativePath) => {
  const resolved = boundary.resolve(relativePath);
  return resolved.ok ? readJson(resolved.path) : null;
};
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|vue|svelte)$/i;
const SOURCE_SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage", ".next", "out",
  "weavatrix-graphs", "weavatrix-graphs", "__pycache__", ".venv", "venv", "env", ".tox", "site-packages",
  ".mypy_cache", ".pytest_cache",
]);

export function collectSourceTexts(repoRoot, graph) {
  const sources = new Map();
  const boundary = createRepoBoundary(repoRoot);
  const add = (rel) => {
    const file = String(rel || "").replace(/\\/g, "/");
    if (!file || sources.has(file)) return;
    const resolved = boundary.resolve(file);
    if (!resolved.ok) return;
    const text = readText(resolved.path);
    if (text != null) sources.set(file, text);
  };

  for (const n of graph.nodes || []) add(n.source_file);

  const walk = (abs, parts = []) => {
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name)) walk(join(abs, entry.name), [...parts, entry.name]);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXT_RE.test(entry.name)) continue;
      add([...parts, entry.name].join("/"));
    }
  };
  walk(repoRoot);
  return sources;
}

// Root config files whose TEXT keeps a dependency "mentioned" (dep-check downgrades/skips those).
// package.json is deliberately ABSENT — every declared dep appears there, it would blank all findings;
// its scripts are passed to dep-check separately via pkg.
const CONFIG_FILES = [
  "tsconfig.json", "jsconfig.json",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs",
  ".babelrc", "babel.config.js", "babel.config.cjs",
  "jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs",
  "vite.config.js", "vite.config.ts", "vite.config.mjs", "vitest.config.js", "vitest.config.ts",
  "webpack.config.js", "rollup.config.js", "esbuild.config.js",
  "postcss.config.js", "postcss.config.cjs", "tailwind.config.js", "tailwind.config.ts",
  ".prettierrc", ".prettierrc.json", "prettier.config.js",
  "playwright.config.js", "playwright.config.ts", "cypress.config.js", "cypress.config.ts",
  "next.config.js", "next.config.mjs", "nuxt.config.ts", "svelte.config.js", "astro.config.mjs",
  "angular.json", "nest-cli.json", ".mocharc.json", ".mocharc.yml",
  "commitlint.config.js", ".lintstagedrc", ".lintstagedrc.json", "knip.json", ".releaserc",
  "electron-builder.yml", "electron-builder.json", "serverless.yml", "Dockerfile", "docker-compose.yml",
  // python tool configs (pyproject.toml is deliberately absent — it DECLARES deps, scanning it would blank findings)
  "tox.ini", "pytest.ini", "setup.cfg", ".pre-commit-config.yaml", "Makefile", "Procfile",
];

export function collectConfigTexts(repoRoot) {
  const map = new Map();
  const boundary = createRepoBoundary(repoRoot);
  for (const f of CONFIG_FILES) { const t = readRepoText(boundary, f); if (t != null) map.set(f, t); }
  try {
    const workflows = boundary.resolve(".github/workflows");
    if (!workflows.ok) throw new Error("workflows directory is outside the repository");
    for (const wf of readdirSync(workflows.path)) {
      if (!/\.ya?ml$/i.test(wf)) continue;
      const t = readRepoText(boundary, `.github/workflows/${wf}`);
      if (t != null) map.set(`.github/workflows/${wf}`, t);
    }
  } catch { /* no workflows */ }
  return map;
}

// Monorepo-local package names: "packages/*"-style workspace globs → each child's package.json name.
// Those are importable without being declared — never "missing" deps.
export function workspacePkgNames(repoRoot, pkg) {
  const names = new Set();
  const boundary = createRepoBoundary(repoRoot);
  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces && pkg.workspaces.packages) || [];
  for (const g of globs) {
    const base = String(g).replace(/\/?\*+.*$/, "");
    let dirs = [];
    if (/\*/.test(String(g))) {
      try {
        const resolvedBase = boundary.resolve(base || ".");
        if (!resolvedBase.ok) continue;
        dirs = readdirSync(resolvedBase.path).map((d) => join(base, d));
      } catch { continue; }
    }
    else dirs = [String(g)];
    for (const d of dirs) {
      const p = readRepoJson(boundary, join(d, "package.json"));
      if (p && p.name) names.add(p.name);
    }
  }
  return names;
}

export const TEST_FILE_RE = /(^|[/])(test|tests|__tests__|spec|e2e|__mocks__)([/]|$)|[._-](test|spec)\.[a-z0-9]+$/i;

// Python declared deps: root requirements*.txt/.in + requirements/ dir + pyproject.toml + Pipfile.
// present=false (no manifest at all) softens missing-dep findings instead of suppressing them.
export function collectPyManifest(repoRoot) {
  const deps = [];
  let present = false;
  let names = [];
  const boundary = createRepoBoundary(repoRoot);
  try { names = readdirSync(boundary.root).filter((n) => /^requirements[\w.-]*\.(txt|in)$/i.test(n)); } catch { /* unreadable root */ }
  try {
    const requirements = boundary.resolve("requirements");
    if (requirements.ok) names.push(...readdirSync(requirements.path).filter((n) => /\.(txt|in)$/i.test(n)).map((n) => `requirements/${n}`));
  } catch { /* no requirements dir */ }
  for (const n of names) {
    const t = readRepoText(boundary, n);
    if (t == null) continue;
    present = true;
    const dev = /dev|test|lint|doc|ci/i.test(n.replace(/^requirements[/\\]?/i, ""));
    for (const d of parseRequirementsNames(t)) deps.push({ ...d, dev });
  }
  const pp = readRepoText(boundary, "pyproject.toml");
  if (pp != null) { const r = parsePyprojectDeps(pp); if (r.present) { present = true; deps.push(...r.deps); } }
  const pf = readRepoText(boundary, "Pipfile");
  if (pf != null) { const r = parsePipfileDeps(pf); if (r.present) { present = true; deps.push(...r.deps); } }
  return { present, deps };
}
