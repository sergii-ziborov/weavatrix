// internal-audit.run.js — the audit runner: loads a repo's graph.json + package.json, runs
// dead-check (files) + computeUnusedExports + dep-check, and emits the unified findings envelope
// (DEPS_SECURITY_PLAN.md §2.2-2.3). Split from internal-audit.js.
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { computeDead, computeUnusedExports } from "./dead-check.js";
import { computeDepFindings, computeGoDepFindings, computePyDepFindings } from "./dep-check.js";
import { parseGoMod } from "./manifests.js";
import { computeStructureFindings } from "./dep-rules.js";
import { makeFinding, summarizeFindings, sortFindings } from "./findings.js";
import { graphOutDirForRepo } from "../graph/layout.js";
import { collectInstalled } from "../security/installed.js";
import { loadStore, queryStore } from "../security/advisory-store.js";
import { matchAdvisories } from "../security/match.js";
import { scanMalware } from "../security/malware-heuristics.js";
import { classifyTyposquat } from "../security/typosquat.js";
import {
  readJson, readRepoText, readRepoJson, collectSourceTexts, collectConfigTexts, workspacePkgNames,
  collectPyManifest, TEST_FILE_RE,
} from "./internal-audit.collect.js";
import { entryFiles, computeReachability } from "./internal-audit.reach.js";
import { createRepoBoundary } from "../repo-path.js";

// Run the internal audit. graph is optional (loaded from the repo's central graph.json when absent);
// advisoryStorePath overrides the default ~/.weavatrix/advisories.json (tests use a scratch path).
// async because the malware sweep shells out to ripgrep.
export async function runInternalAudit(repoPath, { graph, advisoryStorePath, skipMalwareScan = false, malwareExclusions = {}, rgPath = "" } = {}) {
  if (!existsSync(repoPath)) return { ok: false, error: "Repo path not found" };
  const boundary = createRepoBoundary(repoPath);
  if (!boundary.root) return { ok: false, error: "Repository path is unreadable" };
  if (!graph) {
    graph = readJson(join(graphOutDirForRepo(repoPath), "graph.json"));
    if (!graph) return { ok: false, error: "Build the graph first (no graph.json)" };
  }
  const pkg = readRepoJson(boundary, "package.json") || {};
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
  const goModText = readRepoText(boundary, "go.mod");
  const goDep = computeGoDepFindings({ externalImports, goMod: goModText != null ? parseGoMod(goModText) : null });
  const pyDep = computePyDepFindings({ externalImports, pyManifest: collectPyManifest(repoPath), configTexts });

  // structure: cycles / orphans / boundary rules. Rules come from the repo's optional .weavatrix-deps.json
  // (the depcruise-config analogue); no bundled default rules — cycles+orphans are always on.
  const rules = readRepoJson(boundary, ".weavatrix-deps.json") || {};
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
      nodeModulesPresent: boundary.resolve("node_modules").ok,
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
