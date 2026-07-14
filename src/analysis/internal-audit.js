// internal-audit.js — façade over the internal analyzers: loads a repo's graph.json + package.json,
// runs dead-check (files) + computeUnusedExports + dep-check, and emits the unified findings envelope
// (DEPS_SECURITY_PLAN.md §2.2-2.3). ALL filesystem access lives here; the analyzers stay pure.
// P2 will add dep-rules (cycles/orphans/boundary); the security/ analyzers join in P4-P5.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { computeDead, computeUnusedExports, ENTRY_FILE } from "./dead-check.js";
import { computeDepFindings, computeGoDepFindings, computePyDepFindings } from "./dep-check.js";
import { parseGoMod, parseRequirementsNames, parsePyprojectDeps, parsePipfileDeps } from "./manifests.js";
import { computeStructureFindings } from "./dep-rules.js";
import { makeFinding, summarizeFindings, sortFindings } from "./findings.js";
import { graphOutDirForRepo } from "../graph/layout.js";
import { collectInstalled } from "../security/installed.js";
import { loadStore, queryStore } from "../security/advisory-store.js";
import { matchAdvisories } from "../security/match.js";
import { scanMalware } from "../security/malware-heuristics.js";
import { classifyTyposquat } from "../security/typosquat.js";

const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|vue|svelte)$/i;
const SOURCE_SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage", ".next", "out",
  "weavatrix-graphs", "weavatrix-graphs", "__pycache__", ".venv", "venv", "env", ".tox", "site-packages",
  ".mypy_cache", ".pytest_cache",
]);

export function collectSourceTexts(repoRoot, graph) {
  const sources = new Map();
  const add = (rel) => {
    const file = String(rel || "").replace(/\\/g, "/");
    if (!file || sources.has(file)) return;
    const text = readText(join(repoRoot, file));
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

function collectConfigTexts(repoRoot) {
  const map = new Map();
  for (const f of CONFIG_FILES) { const t = readText(join(repoRoot, f)); if (t != null) map.set(f, t); }
  try {
    for (const wf of readdirSync(join(repoRoot, ".github", "workflows"))) {
      if (!/\.ya?ml$/i.test(wf)) continue;
      const t = readText(join(repoRoot, ".github", "workflows", wf));
      if (t != null) map.set(`.github/workflows/${wf}`, t);
    }
  } catch { /* no workflows */ }
  return map;
}

// Monorepo-local package names: "packages/*"-style workspace globs → each child's package.json name.
// Those are importable without being declared — never "missing" deps.
function workspacePkgNames(repoRoot, pkg) {
  const names = new Set();
  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces && pkg.workspaces.packages) || [];
  for (const g of globs) {
    const base = String(g).replace(/\/?\*+.*$/, "");
    let dirs = [];
    if (/\*/.test(String(g))) { try { dirs = readdirSync(join(repoRoot, base)).map((d) => join(base, d)); } catch { continue; } }
    else dirs = [String(g)];
    for (const d of dirs) {
      const p = readJson(join(repoRoot, d, "package.json"));
      if (p && p.name) names.add(p.name);
    }
  }
  return names;
}

const TEST_FILE_RE = /(^|[/])(test|tests|__tests__|spec|e2e|__mocks__)([/]|$)|[._-](test|spec)\.[a-z0-9]+$/i;

// Python declared deps: root requirements*.txt/.in + requirements/ dir + pyproject.toml + Pipfile.
// present=false (no manifest at all) softens missing-dep findings instead of suppressing them.
function collectPyManifest(repoRoot) {
  const deps = [];
  let present = false;
  let names = [];
  try { names = readdirSync(repoRoot).filter((n) => /^requirements[\w.-]*\.(txt|in)$/i.test(n)); } catch { /* unreadable root */ }
  try { names.push(...readdirSync(join(repoRoot, "requirements")).filter((n) => /\.(txt|in)$/i.test(n)).map((n) => `requirements/${n}`)); } catch { /* no requirements dir */ }
  for (const n of names) {
    const t = readText(join(repoRoot, n));
    if (t == null) continue;
    present = true;
    const dev = /dev|test|lint|doc|ci/i.test(n.replace(/^requirements[/\\]?/i, ""));
    for (const d of parseRequirementsNames(t)) deps.push({ ...d, dev });
  }
  const pp = readText(join(repoRoot, "pyproject.toml"));
  if (pp != null) { const r = parsePyprojectDeps(pp); if (r.present) { present = true; deps.push(...r.deps); } }
  const pf = readText(join(repoRoot, "Pipfile"));
  if (pf != null) { const r = parsePipfileDeps(pf); if (r.present) { present = true; deps.push(...r.deps); } }
  return { present, deps };
}
const isFileNode = (n) => !String(n.id).includes("#");

// Entry set for reachability: conventional entry names + package.json main/module/browser/bin/exports +
// html pages (they root classic-script apps) + test files (the runner enters them) + root config files +
// dynamic-import targets. Anything reachable from here is "used"; the rest corroborates unused-file.
function entryFiles(graph, pkg, dynamicTargets) {
  const entries = new Set();
  const pkgEntries = [];
  for (const k of ["main", "module", "browser"]) if (typeof pkg[k] === "string") pkgEntries.push(pkg[k]);
  if (pkg.bin) pkgEntries.push(...(typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin)));
  (function walkExports(e) {
    if (typeof e === "string") pkgEntries.push(e);
    else if (e && typeof e === "object") Object.values(e).forEach(walkExports);
  })(pkg.exports);
  const pe = new Set(pkgEntries.map((p) => String(p).replace(/^\.\//, "").replace(/\\/g, "/")));
  for (const n of graph.nodes || []) {
    if (!isFileNode(n)) continue;
    const f = n.source_file;
    if (ENTRY_FILE.test(f) || TEST_FILE_RE.test(f) || /\.html?$/i.test(f) || pe.has(f) || /(^|\/)[^/]*\.config\.[a-z]+$/i.test(f)) entries.add(f);
  }
  for (const t of dynamicTargets) entries.add(t);
  return entries;
}

// File-level BFS over every non-contains link (symbol endpoints collapse to their file via the id prefix).
function computeReachability(graph, entries) {
  const fileOf = (v) => { const s = String(v && typeof v === "object" ? v.id : v); const h = s.indexOf("#"); return h < 0 ? s : s.slice(0, h); };
  const adj = new Map();
  for (const l of graph.links || []) {
    if (l.relation === "contains") continue;
    const a = fileOf(l.source), b = fileOf(l.target);
    if (!a || !b || a === b) continue;
    (adj.get(a) || adj.set(a, new Set()).get(a)).add(b);
  }
  const reached = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const cur = queue.pop();
    for (const nxt of adj.get(cur) || []) if (!reached.has(nxt)) { reached.add(nxt); queue.push(nxt); }
  }
  return reached;
}

// Run the internal audit. graph is optional (loaded from the repo's central graph.json when absent);
// advisoryStorePath overrides the default ~/.weavatrix/advisories.json (tests use a scratch path).
// async because the malware sweep shells out to ripgrep.
export async function runInternalAudit(repoPath, { graph, advisoryStorePath, skipMalwareScan = false, malwareExclusions = {}, rgPath = "" } = {}) {
  if (!existsSync(repoPath)) return { ok: false, error: "Repo path not found" };
  if (!graph) {
    graph = readJson(join(graphOutDirForRepo(repoPath), "graph.json"));
    if (!graph) return { ok: false, error: "Build the graph first (no graph.json)" };
  }
  const pkg = readJson(join(repoPath, "package.json")) || {};
  const externalImports = graph.externalImports || [];
  const dynamicTargets = new Set(externalImports.filter((e) => e.dynamic && e.target).map((e) => e.target));

  // Graphs can be stale or miss a helper file; text fallbacks must scan the real repo tree too.
  const sources = collectSourceTexts(repoPath, graph);

  const dead = computeDead(graph, sources);
  const unusedExports = computeUnusedExports(graph, sources, { dynamicTargets });
  const entries = entryFiles(graph, pkg, dynamicTargets);
  const reachable = computeReachability(graph, entries);
  const configTexts = collectConfigTexts(repoPath);
  const dep = computeDepFindings({ externalImports, pkg, workspacePkgNames: workspacePkgNames(repoPath, pkg), configTexts });
  // non-npm ecosystems: Go (go.mod) + Python (requirements/pyproject/Pipfile) — same findings shape
  const goModText = readText(join(repoPath, "go.mod"));
  const goDep = computeGoDepFindings({ externalImports, goMod: goModText != null ? parseGoMod(goModText) : null });
  const pyDep = computePyDepFindings({ externalImports, pyManifest: collectPyManifest(repoPath), configTexts });

  // structure: cycles / orphans / boundary rules. Rules come from the repo's optional .weavatrix-deps.json
  // (the depcruise-config analogue); no bundled default rules — cycles+orphans are always on.
  const rules = readJson(join(repoPath, ".weavatrix-deps.json")) || {};
  const externalImportFiles = new Set(externalImports.filter((e) => e.pkg && !e.builtin).map((e) => e.file));
  const structure = computeStructureFindings(graph, { rules, entrySet: entries, externalImportFiles });

  const findings = [...dep.findings, ...goDep.findings, ...pyDep.findings];
  // orphan ∩ dead-file → one finding: keep the stronger unused-file, drop the duplicate orphan
  const deadFileSet = new Set(dead.deadFiles.map((f) => f.file));
  for (const f of structure.findings) if (!(f.rule === "orphan-file" && deadFileSet.has(f.file))) findings.push(f);
  for (const f of dead.deadFiles) {
    if (dynamicTargets.has(f.file) || TEST_FILE_RE.test(f.file)) continue;
    findings.push(makeFinding({
      category: "unused",
      rule: "unused-file",
      severity: "low",
      confidence: reachable.has(f.file) ? "medium" : "high", // unreachable from every entry = strong corroboration
      title: `Unused file: ${f.file}`,
      detail: `${f.reason}${reachable.has(f.file) ? "" : "; also unreachable from every entry point"}. Dynamic loading and framework conventions can't be fully ruled out — review before deleting.`,
      file: f.file,
      graphNodeId: f.file,
      source: "internal",
      fixHint: "review, then delete the file",
    }));
  }
  for (const s of unusedExports) {
    if (s.test) continue; // exports from test files are runner-visible noise
    if (/(^|\/)[^/]*\.config\.[a-z0-9]+$|(^|\/)\.[^/]+rc(\.[a-z]+)?$/i.test(s.file)) continue; // config exports are consumed by their tool
    findings.push(makeFinding({
      category: "unused",
      rule: "unused-export",
      severity: "info",
      confidence: "medium",
      title: `Unused export: ${s.label.replace(/\(\)$/, "")} — ${s.file}`,
      detail: `${s.reason}. Either remove the export keyword (if used only internally) or delete the symbol.`,
      file: s.file,
      symbol: s.label,
      graphNodeId: s.id,
      source: "internal",
    }));
  }

  // ---- supply-chain: installed packages × cached OSV advisories. 100% OFFLINE here — the cache is
  // refreshed only by the explicit repos:advisory-refresh action. Never blocks the rest of the audit.
  let advisoryDbDate = null;
  let installedCount = 0;
  let inst = { installed: [], drift: [] };
  try {
    inst = collectInstalled(repoPath);
    installedCount = inst.installed.length;
    const store = advisoryStorePath ? loadStore(advisoryStorePath) : loadStore();
    // per-repo date when the store tracks it (cache only covers QUERIED packages); legacy stores
    // without the repos map keep the old global-date behavior
    advisoryDbDate = store.meta?.repos ? store.meta.repos[repoPath] || null : store.meta?.fetched_at || null;
    if (advisoryDbDate) {
      for (const h of matchAdvisories(inst.installed, (eco, name) => queryStore(store, eco, name))) {
        const mal = h.adv.kind === "malicious";
        findings.push(makeFinding({
          category: mal ? "malware" : "vulnerability",
          rule: mal ? "malicious-package" : "known-vuln",
          severity: mal ? "critical" : h.adv.severity,
          confidence: h.confidence,
          title: `${mal ? "Known-malicious package" : `Known vulnerability (${h.adv.id})`}: ${h.pkg.name}@${h.pkg.version}`,
          detail: `${h.adv.summary || h.adv.id}${h.adv.fixedIn.length ? ` Fixed in: ${h.adv.fixedIn.join(", ")}.` : mal ? " Remove this package immediately and rotate any secrets it could reach." : ""} (matched by ${h.matchedBy}${h.adv.aliases.length ? `; aliases ${h.adv.aliases.join(", ")}` : ""})`,
          package: h.pkg.name,
          version: h.pkg.version,
          evidence: [{ file: h.adv.url, line: 0, snippet: `installed via ${h.pkg.source}${h.pkg.dev ? " (dev)" : ""}` }],
          source: "osv",
          fixHint: mal ? `npm uninstall ${h.pkg.name} + audit what it touched` : h.adv.fixedIn.length ? `upgrade ${h.pkg.name} to ${h.adv.fixedIn[h.adv.fixedIn.length - 1]}+` : "no fixed version published — consider replacing the package",
        }));
      }
    }
    // direct-dependency typosquat (dev-chosen names, small set → low FP): surface quietly even alone.
    for (const name of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
      const sq = classifyTyposquat(name);
      if (!sq) continue;
      findings.push(makeFinding({
        category: "malware",
        rule: "typosquat",
        severity: "medium",
        confidence: "low",
        title: `Possible typosquat: ${name} (looks like "${sq.nearest}")`,
        detail: `Direct dependency "${name}" is edit-distance ${sq.distance} from the popular package "${sq.nearest}". Confirm you meant "${name}" and not "${sq.nearest}" — name-confusion is a common supply-chain lure.`,
        package: name,
        source: "internal",
        fixHint: `verify "${name}" is the intended package (not a typo of "${sq.nearest}")`,
      }));
    }
    for (const d of inst.drift.slice(0, 20)) {
      findings.push(makeFinding({
        category: "malware",
        rule: "lockfile-drift",
        severity: "low",
        confidence: "medium",
        title: `Lockfile drift: ${d.name} (locked ${d.locked}, installed ${d.installed})`,
        detail: "The version on disk differs from the lockfile — a stale install, a manual edit, or (worst case) tampering. Reinstall from the lockfile to realign.",
        package: d.name,
        version: d.installed,
        source: "internal",
        fixHint: "npm ci (clean install from the lockfile)",
      }));
    }
  } catch { /* supply-chain layer is best-effort */ }

  // ---- malware heuristics: install-script beacons / miners / exfil / obfuscation across installed libs.
  // Local + offline (ripgrep or a bounded Node fallback). Scans node_modules, Python venvs, Go vendor/cache.
  let malwareScan = null;
  if (!skipMalwareScan) {
    try {
      const importedPkgs = new Set(externalImports.filter((e) => e.pkg && !e.builtin).map((e) => e.pkg));
      const scan = await scanMalware(repoPath, { installed: inst.installed, importedPkgs, malwareExclusions, rgPath });
      findings.push(...scan.findings);
      malwareScan = { scanMode: scan.scanMode, packagesScanned: scan.packagesScanned, findings: scan.findings.length, excludedSignals: scan.excludedSignals || 0 };
    } catch { /* heuristic scan is best-effort */ }
  }

  const sorted = sortFindings(findings);
  return {
    ok: true,
    engine: "internal",
    repo: basename(repoPath),
    path: repoPath,
    savedAt: new Date().toISOString(),
    scanned: {
      files: dead.stats.files,
      symbols: dead.stats.symbols,
      manifestDeps: dep.declared.size + goDep.declared.size + pyDep.declared.size,
      externalImports: externalImports.length,
      nodeModulesPresent: existsSync(join(repoPath, "node_modules")),
      installedPackages: installedCount,
      advisoryDbDate,
      malwareScanMode: malwareScan?.scanMode || "skipped",
    },
    summary: summarizeFindings(sorted),
    findings: sorted,
    deadReport: { deadSymbols: dead.deadSymbols.length, deadFiles: dead.deadFiles.length, unusedExports: unusedExports.length },
    structureReport: structure.stats,
    malwareScan,
  };
}
