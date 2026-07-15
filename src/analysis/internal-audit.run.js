// internal-audit.run.js — the audit runner: loads a repo's graph.json + package.json, runs
// dead-check (files) + computeUnusedExports + dep-check, and emits the unified findings envelope
// (DEPS_SECURITY_PLAN.md §2.2-2.3). Split from internal-audit.js.
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { computeDead, computeUnusedExports } from "./dead-check.js";
import { computeScopedDepFindings, computeGoDepFindings, computePyDepFindings } from "./dep-check.js";
import { parseGoMod } from "./manifests.js";
import { computeStructureFindings } from "./dep-rules.js";
import { makeFinding, summarizeFindings, sortFindings } from "./findings.js";
import { graphOutDirForRepo } from "../graph/layout.js";
import { collectInstalled } from "../security/installed.js";
import { loadStore, queryStore, advisoryQueryFingerprint } from "../security/advisory-store.js";
import { matchAdvisories } from "../security/match.js";
import { scanMalware } from "../security/malware-heuristics.js";
import { classifyTyposquat } from "../security/typosquat.js";
import {
  readJson, readRepoText, readRepoJson, collectSourceTexts, collectConfigTexts, workspacePkgNames,
  collectPackageScopes, collectPyManifest, collectNonRuntimeRoots, TEST_FILE_RE,
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
  const packageScopes = collectPackageScopes(repoPath, pkg);
  const externalImports = graph.externalImports || [];
  const dynamicTargets = new Set(externalImports.filter((e) => e.dynamic && e.target).map((e) => e.target));
  const rules = readRepoJson(boundary, ".weavatrix-deps.json") || {};

  // Graphs can be stale or miss a helper file; text fallbacks must scan the real repo tree too.
  const sources = collectSourceTexts(repoPath, graph);
  const nonRuntimeRoots = collectNonRuntimeRoots(repoPath, rules);

  const entries = entryFiles(graph, packageScopes, dynamicTargets, {
    declaredEntries: rules.entrypoints || rules.entries || [],
    sources,
  });
  for (const file of sources.keys()) {
    if (nonRuntimeRoots.some((root) => file === root || file.startsWith(`${root}/`))) entries.add(file);
  }
  const dead = computeDead(graph, sources, { entrySet: entries });
  const unusedExports = computeUnusedExports(graph, sources, { dynamicTargets, entrySet: entries });
  const reachable = computeReachability(graph, entries);
  const configTexts = collectConfigTexts(repoPath);
  const dep = computeScopedDepFindings({ externalImports, packageScopes, workspacePkgNames: workspacePkgNames(repoPath, pkg), configTexts, nonRuntimeRoots });
  // non-npm ecosystems: Go (go.mod) + Python (requirements/pyproject/Pipfile) — same findings shape
  const goModText = readRepoText(boundary, "go.mod");
  const goDep = computeGoDepFindings({ externalImports, goMod: goModText != null ? parseGoMod(goModText) : null, nonRuntimeRoots });
  const asList = (v) => Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const pyRules = rules.python || {};
  const depRules = rules.dependencies || {};
  const managedPython = [...new Set([
    ...asList(rules.managedPythonDependencies), ...asList(pyRules.managed), ...asList(pyRules.managedDependencies),
    ...asList(depRules.managedPython),
  ])];
  const ignoredPython = [...new Set([
    ...asList(rules.ignorePythonDependencies), ...asList(pyRules.ignore), ...asList(pyRules.ignoreDependencies),
    ...asList(depRules.ignorePython),
  ])];
  const pyDep = computePyDepFindings({
    externalImports, pyManifest: collectPyManifest(repoPath), configTexts,
    managedDependencies: managedPython, ignoredDependencies: ignoredPython, nonRuntimeRoots,
  });

  // structure: cycles / orphans / boundary rules. Rules come from the repo's optional .weavatrix-deps.json
  // (the depcruise-config analogue); no bundled default rules — cycles+orphans are always on.
  const externalImportFiles = new Set(externalImports.filter((e) => e.pkg && !e.builtin).map((e) => e.file));
  const structure = computeStructureFindings(graph, { rules, entrySet: entries, externalImportFiles });

  const findings = [...dep.findings, ...goDep.findings, ...pyDep.findings];
  // orphan ∩ dead-file → one finding: keep the stronger unused-file, drop the duplicate orphan
  const deadFileSet = new Set(dead.deadFiles.map((f) => f.file));
  for (const f of structure.findings) if (!(f.rule === "orphan-file" && deadFileSet.has(f.file))) findings.push(f);
  for (const f of dead.deadFiles) {
    if (entries.has(f.file) || dynamicTargets.has(f.file) || TEST_FILE_RE.test(f.file)) continue;
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
  let unusedExportCount = 0;
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
    unusedExportCount++;
  }

  // ---- supply-chain: installed packages × cached OSV advisories. 100% OFFLINE here — the cache is
  // refreshed only by the explicit repos:advisory-refresh action. Never blocks the rest of the audit.
  let advisoryDbDate = null;
  let installedCount = 0;
  let inst = { installed: [], drift: [] };
  const checks = {
    osv: { status: "NOT_CHECKED", detail: "Advisory cache was never refreshed for this repository. The refresh_advisories tool belongs to the optional online capability group: enable that group in the MCP registration, then call the tool explicitly to opt in to sending pinned package names and versions to OSV.dev." },
    malware: { status: skipMalwareScan ? "NOT_CHECKED" : "PENDING", detail: skipMalwareScan ? "Installed-package malware scan is opt-in and was not requested." : "" },
  };
  try {
    inst = collectInstalled(repoPath);
    installedCount = inst.installed.length;
    const store = advisoryStorePath ? loadStore(advisoryStorePath) : loadStore();
    // Only a per-repo stamp proves that this repository's installed versions were queried. A legacy
    // global fetched_at may belong to another repo and must never certify this one as clean.
    const repoStamp = store.meta?.repos?.[repoPath] || null;
    advisoryDbDate = typeof repoStamp === "string" ? repoStamp : repoStamp?.fetched_at || null;
    if (advisoryDbDate) {
      let status = typeof repoStamp === "object" && ["OK", "PARTIAL", "ERROR"].includes(repoStamp.status) ? repoStamp.status : "PARTIAL";
      const fingerprintMatches = typeof repoStamp === "object" && repoStamp.query_fingerprint === advisoryQueryFingerprint(inst.installed);
      if (!fingerprintMatches && status === "OK") status = "PARTIAL";
      const coverage = typeof repoStamp === "object" && Number.isFinite(repoStamp.queried)
        ? ` (${repoStamp.queried_ok ?? repoStamp.queried}/${repoStamp.queried} package versions queried successfully)`
        : "";
      const drift = fingerprintMatches ? "" : " Dependency versions changed, or this is a legacy stamp without a package fingerprint; enable the optional online capability group and call refresh_advisories for complete coverage.";
      checks.osv = {
        status,
        detail: `${status === "PARTIAL" ? "Partially matched" : "Matched"} installed packages against the cached OSV snapshot from ${advisoryDbDate}${coverage}.${drift}`,
        checkedAt: advisoryDbDate,
      };
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
    const directDependencyNames = new Set(packageScopes.flatMap((s) => Object.keys({ ...(s.pkg?.dependencies || {}), ...(s.pkg?.devDependencies || {}) })));
    for (const name of directDependencyNames) {
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
  } catch (error) {
    checks.osv = { status: "ERROR", detail: `Offline advisory matching failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  // ---- malware heuristics: install-script beacons / miners / exfil / obfuscation across installed libs.
  // Local + offline (ripgrep or a bounded Node fallback). Scans node_modules, Python venvs, Go vendor/cache.
  let malwareScan = null;
  if (!skipMalwareScan) {
    try {
      const importedPkgs = new Set(externalImports.filter((e) => e.pkg && !e.builtin).map((e) => e.pkg));
      const scan = await scanMalware(repoPath, { installed: inst.installed, importedPkgs, malwareExclusions, rgPath });
      findings.push(...scan.findings);
      malwareScan = { scanMode: scan.scanMode, packagesScanned: scan.packagesScanned, findings: scan.findings.length, excludedSignals: scan.excludedSignals || 0 };
      checks.malware = { status: "OK", detail: `Scanned ${scan.packagesScanned} installed package(s) using ${scan.scanMode}.` };
    } catch (error) {
      checks.malware = { status: "ERROR", detail: `Installed-package malware scan failed: ${error instanceof Error ? error.message : String(error)}` };
    }
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
      advisoryStatus: checks.osv.status,
      malwareScanMode: malwareScan?.scanMode || "skipped",
      malwareStatus: checks.malware.status,
      packageScopes: packageScopes.length,
      managedPythonDependencies: managedPython.length,
      nonRuntimeRoots,
    },
    summary: summarizeFindings(sorted),
    findings: sorted,
    deadReport: { deadSymbols: dead.deadSymbols.length, deadFiles: dead.deadFiles.length, unusedExports: unusedExportCount },
    structureReport: structure.stats,
    checks,
    malwareScan,
  };
}
