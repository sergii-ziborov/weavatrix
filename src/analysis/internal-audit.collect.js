// internal-audit.collect.js — filesystem collection helpers for the internal audit: source/config
// text gathering, workspace package names, and the Python manifest reader. Split from internal-audit.js.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseRequirementsNames, parsePyprojectDeps, parsePipfileDeps, pep503 } from "./manifests.js";
import { createRepoBoundary } from "../repo-path.js";
import { childProcessEnv } from "../child-env.js";
import { filterWeavatrixIgnored } from "../path-ignore.js";

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
  "release", "weavatrix-graphs", "__pycache__", ".venv", "venv", "env", ".tox", "site-packages",
  ".mypy_cache", ".pytest_cache",
]);

// One file universe for every filesystem-backed audit. In Git repos this exactly matches tracked files
// plus untracked/non-ignored work, so release bundles and other .gitignore outputs cannot re-enter through
// text/config/manifest fallback collectors after the graph builder correctly omitted them.
export function listRepoFiles(repoRoot) {
  try {
    const r = spawnSync("git", ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
      env: childProcessEnv(),
    });
    if (r.status === 0) return filterWeavatrixIgnored(repoRoot, String(r.stdout || "").split("\0").filter(Boolean).map((f) => f.replace(/\\/g, "/")));
  } catch { /* non-Git repo or git unavailable: use the bounded walker below */ }

  const files = [];
  const walk = (abs, parts = []) => {
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name)) walk(join(abs, entry.name), [...parts, entry.name]);
      } else if (entry.isFile()) files.push([...parts, entry.name].join("/"));
    }
  };
  walk(repoRoot);
  return filterWeavatrixIgnored(repoRoot, files);
}

const NON_RUNTIME_DIR_RE = /^(?:templates?|examples?|samples?|fixtures?|snippets?|__fixtures__)$/i;
const NON_RUNTIME_README_RE = /(?:\b(?:reusable|copyable|reference)\b[\s\S]{0,160}\b(?:templates?|snippets?|examples?|samples?)\b|\b(?:these|contents?)\s+are\s+templates?\b)/i;
const normConfiguredRoot = (value) => {
  const root = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!root || root === "." || root.split("/").some((part) => part === "..")) return "";
  return root;
};

// Runtime health findings should not treat copy-paste catalogs as deployed applications. Conventional
// template/example directories are safe to infer; a top-level custom catalog is inferred only when its
// own README explicitly describes reusable templates/snippets. Projects can declare additional roots in
// `.weavatrix-deps.json` through `nonRuntimeRoots` / `templateRoots`.
export function collectNonRuntimeRoots(repoRoot, rules = {}) {
  const files = listRepoFiles(repoRoot);
  const roots = new Set();
  const configured = [
    rules.nonRuntimeRoots, rules.templateRoots,
    rules.dependencies?.nonRuntimeRoots, rules.dependencies?.templateRoots,
  ].flatMap((value) => Array.isArray(value) ? value : typeof value === "string" ? [value] : []);
  for (const value of configured) {
    const root = normConfiguredRoot(value);
    if (root) roots.add(root);
  }

  for (const file of files) {
    const parts = file.replace(/\\/g, "/").split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (NON_RUNTIME_DIR_RE.test(parts[i])) roots.add(parts.slice(0, i + 1).join("/"));
    }
  }

  const boundary = createRepoBoundary(repoRoot);
  for (const file of files) {
    if (!/^[^/]+\/README\.md$/i.test(file)) continue; // custom inference is deliberately top-level only
    const text = readRepoText(boundary, file);
    if (text != null && NON_RUNTIME_README_RE.test(text)) roots.add(normRoot(dirname(file)));
  }
  return [...roots].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

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

  for (const file of listRepoFiles(repoRoot)) if (SOURCE_EXT_RE.test(file)) add(file);
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
  "postcss.config.js", "postcss.config.cjs", "postcss.config.mjs", "postcss.config.ts",
  "tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts",
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
  const names = new Set(CONFIG_FILES.map((f) => f.toLowerCase()));
  for (const f of listRepoFiles(repoRoot)) {
    const base = f.slice(f.lastIndexOf("/") + 1).toLowerCase();
    if (!names.has(base) && !/^\.github\/workflows\/.*\.ya?ml$/i.test(f)) continue;
    const t = readRepoText(boundary, f);
    if (t != null) map.set(f, t);
  }
  return map;
}

function readJsonc(text) {
  if (text == null) return null;
  try {
    const input = String(text).replace(/^\uFEFF/, "");
    let clean = "", inString = false, escaped = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i], next = input[i + 1];
      if (inString) {
        clean += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; clean += ch; continue; }
      if (ch === "/" && next === "/") {
        while (i < input.length && input[i] !== "\n") i++;
        clean += "\n";
        continue;
      }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
        i++;
        continue;
      }
      clean += ch;
    }
    clean = clean.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(clean);
  } catch { return null; }
}

const normRoot = (root) => {
  const value = String(root || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  return value === "." ? "" : value;
};
const inScope = (file, root) => !root || file === root || file.startsWith(`${root}/`);

function aliasesForScope(repoRoot, root, files, boundary, scopeRoots) {
  const ownerOf = (file) => scopeRoots.find((candidate) => inScope(file, candidate)) ?? "";
  const configs = files
    .filter((f) => ownerOf(f) === root && /(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(f))
    .filter((f) => normRoot(dirname(f)) === root)
    .sort((a, b) => Number(!/(^|\/)(?:tsconfig|jsconfig)\.json$/i.test(a)) - Number(!/(^|\/)(?:tsconfig|jsconfig)\.json$/i.test(b)) || a.localeCompare(b));
  const aliases = new Map();
  for (const config of configs) {
    const cfg = readJsonc(readRepoText(boundary, config));
    const paths = cfg?.compilerOptions?.paths || {};
    for (const key of Object.keys(paths)) if (!aliases.has(key)) aliases.set(key, {
      key,
      prefix: String(key).replace(/\*.*$/, ""),
      suffix: String(key).includes("*") ? String(key).slice(String(key).indexOf("*") + 1) : "",
      config,
    });
  }
  return [...aliases.values()];
}

// Every package.json defines a dependency scope. The nearest ancestor manifest owns an import, matching
// npm workspace/package semantics. Aliases are collected from that scope's tsconfig/jsconfig so `@/*`
// remains local rather than becoming a phantom npm package.
export function collectPackageScopes(repoRoot, rootPkg = null) {
  const boundary = createRepoBoundary(repoRoot);
  const files = listRepoFiles(repoRoot);
  const manifests = files.filter((f) => /(^|\/)package\.json$/i.test(f));
  if (!manifests.includes("package.json") && rootPkg) manifests.unshift("package.json");
  const uniqueManifests = [...new Set(manifests)];
  const scopeRoots = uniqueManifests
    .map((manifest) => manifest === "package.json" ? "" : normRoot(dirname(manifest)))
    .sort((a, b) => b.length - a.length);
  const scopes = [];
  for (const manifest of uniqueManifests) {
    const root = manifest === "package.json" ? "" : normRoot(dirname(manifest));
    const pkg = manifest === "package.json" && rootPkg ? rootPkg : readRepoJson(boundary, manifest);
    if (!pkg || typeof pkg !== "object") continue;
    scopes.push({ root, manifest, pkg, aliases: aliasesForScope(repoRoot, root, files, boundary, scopeRoots) });
  }
  if (!scopes.some((s) => !s.root)) scopes.push({ root: "", manifest: "package.json", pkg: rootPkg || {}, aliases: aliasesForScope(repoRoot, "", files, boundary, [...scopeRoots, ""]) });
  return scopes.sort((a, b) => b.root.length - a.root.length);
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
  for (const scope of collectPackageScopes(repoRoot, pkg)) if (scope.pkg?.name) names.add(scope.pkg.name);
  return names;
}

export const TEST_FILE_RE = /(^|[/])(test|tests|__tests__|spec|e2e|__mocks__)([/]|$)|[._-](test|spec)\.[a-z0-9]+$/i;

// Python declared deps are owned by the nearest manifest root, matching nested service/monorepo
// layouts. `requirements/*.txt` belongs to the directory above `requirements`; a colocated
// requirements.txt, pyproject.toml or Pipfile owns its own directory.
// present=false (no manifest at all) softens missing-dep findings instead of suppressing them.
export function collectPyManifest(repoRoot) {
  const boundary = createRepoBoundary(repoRoot);
  const scopes = new Map();
  const scopeFor = (root) => {
    const normalized = normRoot(root);
    if (!scopes.has(normalized)) scopes.set(normalized, { root: normalized, present: false, deps: [], manifests: [] });
    return scopes.get(normalized);
  };
  const addManifest = (root, manifest, parsedDeps, present = true) => {
    if (!present) return;
    const scope = scopeFor(root);
    scope.present = true;
    scope.manifests.push(manifest);
    scope.deps.push(...parsedDeps.map((dep) => ({ ...dep, manifest })));
  };
  const files = listRepoFiles(repoRoot);
  for (const file of files.filter((name) => /(^|\/)requirements[\w.-]*\.(?:txt|in)$/i.test(name)
    || /(^|\/)requirements\/[^/]+\.(?:txt|in)$/i.test(name))) {
    const t = readRepoText(boundary, file);
    if (t == null) continue;
    const parent = normRoot(dirname(file));
    const root = /(^|\/)requirements$/i.test(parent) ? normRoot(dirname(parent)) : parent;
    const dev = /dev|test|lint|doc|ci/i.test(file.slice(file.lastIndexOf("/") + 1));
    addManifest(root, file, parseRequirementsNames(t).map((dep) => ({ ...dep, dev })));
  }
  for (const file of files.filter((name) => /(^|\/)pyproject\.toml$/i.test(name))) {
    const parsed = parsePyprojectDeps(readRepoText(boundary, file));
    addManifest(dirname(file), file, parsed.deps, parsed.present);
  }
  for (const file of files.filter((name) => /(^|\/)Pipfile$/i.test(name))) {
    const parsed = parsePipfileDeps(readRepoText(boundary, file));
    addManifest(dirname(file), file, parsed.deps, parsed.present);
  }
  const normalizedScopes = [...scopes.values()]
    .map((scope) => {
      const seen = new Set();
      return {
        ...scope,
        manifests: [...new Set(scope.manifests)].sort(),
        deps: scope.deps.filter((dep) => {
          const key = pep503(dep.name);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    })
    .sort((left, right) => right.root.length - left.root.length || left.root.localeCompare(right.root));
  return {
    present: normalizedScopes.some((scope) => scope.present),
    deps: normalizedScopes.flatMap((scope) => scope.deps),
    scopes: normalizedScopes,
  };
}
