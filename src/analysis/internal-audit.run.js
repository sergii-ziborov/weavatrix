import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { computeDead, computeUnusedExports } from "./dead-check.js";
import { computePyDepFindings, computeScopedDepFindings } from "./dep-check.js";
import { computeStructureFindings } from "./dep-rules.js";
import { makeFinding, sortFindings, summarizeFindings } from "./findings.js";
import { graphOutDirForRepo } from "../graph/layout.js";
import {
  TEST_FILE_RE,
  collectConfigTexts,
  collectNonRuntimeRoots,
  collectPackageScopes,
  collectPyManifest,
  collectSourceTexts,
  listRepoFiles,
  readJson,
  readRepoJson,
  workspacePkgNames,
} from "./internal-audit.collect.js";
import { computeReachability, entryFiles } from "./internal-audit.reach.js";
import { PATH_CLASS_NAMES, createPathClassifier, hasPathClass } from "../path-classification.js";
import { createRepoBoundary } from "../repo-path.js";
import { analyzeSourceCorrectness } from "./source-correctness.js";
import { collectJvmDependencyEvidence } from "./jvm-dependency-evidence.js";
import { buildDependencyHealth } from "./internal-audit/dependency-health.js";
import { runSupplyChainChecks } from "./internal-audit/supply-chain.js";
import { collectGoDependencyEvidence } from "./go-dependency-evidence.js";
import { collectCargoDependencyEvidence } from "./cargo-dependency-evidence.js";

export async function runInternalAudit(repoPath, {
  graph,
  advisoryStorePath,
  skipMalwareScan = false,
  malwareExclusions = {},
  rgPath = "",
} = {}) {
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
  const dynamicTargets = new Set(externalImports.filter((entry) => entry.dynamic && entry.target).map((entry) => entry.target));
  const rules = readRepoJson(boundary, ".weavatrix-deps.json") || {};
  const repoFiles = listRepoFiles(repoPath);
  const sources = collectSourceTexts(repoPath, graph);
  const nonRuntimeRoots = collectNonRuntimeRoots(repoPath, rules);

  const pathClassifier = createPathClassifier(repoPath);
  const pathClassifications = new Map();
  const classifyPath = (file) => {
    const normalized = String(file || "").replace(/\\/g, "/");
    if (!pathClassifications.has(normalized)) {
      pathClassifications.set(normalized, pathClassifier.explain(normalized, { content: sources.get(normalized) }));
    }
    return pathClassifications.get(normalized);
  };
  const isNonProductPath = (file) => {
    const info = classifyPath(file);
    return info.excluded || hasPathClass(info, "test", "e2e", "generated", "mock", "story", "docs", "benchmark", "temp");
  };

  const conventionEvidence = [];
  const entries = entryFiles(graph, packageScopes, dynamicTargets, {
    declaredEntries: rules.entrypoints || rules.entries || [],
    sources,
    conventionEvidence,
  });
  for (const file of sources.keys()) {
    if (nonRuntimeRoots.some((root) => file === root || file.startsWith(`${root}/`))) entries.add(file);
    if (isNonProductPath(file)) entries.add(file);
  }
  const dead = computeDead(graph, sources, { entrySet: entries });
  const unusedExports = computeUnusedExports(graph, sources, { dynamicTargets, entrySet: entries });
  const reachable = computeReachability(graph, entries);
  const configTexts = collectConfigTexts(repoPath);
  const npmDependencyImports = externalImports.filter((entry) => entry.ecosystem
    ? entry.ecosystem === "npm"
    : !/\.(?:java|go|py)$/i.test(entry.file || ""));
  const dep = computeScopedDepFindings({
    externalImports: npmDependencyImports,
    packageScopes,
    workspacePkgNames: workspacePkgNames(repoPath, pkg),
    configTexts,
    sourceTexts: sources,
    nonRuntimeRoots,
    sourceFiles: [...sources.keys()],
  });
  const goDep = collectGoDependencyEvidence(repoPath, { files: repoFiles, externalImports, nonRuntimeRoots });
  const asList = (value) => Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const pyRules = rules.python || {}, depRules = rules.dependencies || {};
  const managedPython = [...new Set([
    ...asList(rules.managedPythonDependencies), ...asList(pyRules.managed), ...asList(pyRules.managedDependencies), ...asList(depRules.managedPython),
  ])];
  const ignoredPython = [...new Set([
    ...asList(rules.ignorePythonDependencies), ...asList(pyRules.ignore), ...asList(pyRules.ignoreDependencies), ...asList(depRules.ignorePython),
  ])];
  const pyManifest = collectPyManifest(repoPath);
  const pyDep = computePyDepFindings({
    externalImports,
    pyManifest,
    configTexts,
    managedDependencies: managedPython,
    ignoredDependencies: ignoredPython,
    nonRuntimeRoots,
  });
  const jvmDependencies = collectJvmDependencyEvidence(repoPath, { files: repoFiles, externalImports });
  const cargoDep = collectCargoDependencyEvidence(repoPath, { files: repoFiles, externalImports });

  const externalImportFiles = new Set(externalImports.filter((entry) => entry.pkg && !entry.builtin).map((entry) => entry.file));
  const structure = computeStructureFindings(graph, { rules, entrySet: entries, externalImportFiles });
  const correctness = analyzeSourceCorrectness(sources, { isNonProductPath });
  const findings = [
    ...dep.findings, ...goDep.findings, ...pyDep.findings,
    ...jvmDependencies.maven.findings, ...jvmDependencies.gradle.findings, ...cargoDep.findings,
    ...correctness.findings,
  ];
  const deadFileSet = new Set(dead.deadFiles.map((finding) => finding.file));
  for (const finding of structure.findings) {
    if (!(finding.rule === "orphan-file" && deadFileSet.has(finding.file))) findings.push(finding);
  }

  const actionableDeadFiles = dead.deadFiles.filter((finding) => !isNonProductPath(finding.file));
  for (const finding of actionableDeadFiles) {
    if (entries.has(finding.file) || dynamicTargets.has(finding.file) || TEST_FILE_RE.test(finding.file)) continue;
    findings.push(makeFinding({
      category: "unused",
      rule: "unused-file",
      severity: "low",
      confidence: reachable.has(finding.file) ? "medium" : "high",
      title: `Unused file: ${finding.file}`,
      detail: `${finding.reason}${reachable.has(finding.file) ? "" : "; also unreachable from every entry point"}. Dynamic loading and framework conventions can't be fully ruled out — review before deleting.`,
      file: finding.file,
      graphNodeId: finding.file,
      source: "internal",
      fixHint: "review, then delete the file",
    }));
  }
  let unusedExportCount = 0;
  for (const symbol of unusedExports) {
    if (symbol.test || isNonProductPath(symbol.file)) continue;
    if (/(^|\/)[^/]*\.config\.[a-z0-9]+$|(^|\/)\.[^/]+rc(\.[a-z]+)?$/i.test(symbol.file)) continue;
    findings.push(makeFinding({
      category: "unused",
      rule: "unused-export",
      severity: "info",
      confidence: "medium",
      title: `Unused export: ${symbol.label.replace(/\(\)$/, "")} — ${symbol.file}`,
      detail: `${symbol.reason}. Either remove the export keyword (if used only internally) or delete the symbol.`,
      file: symbol.file,
      symbol: symbol.label,
      graphNodeId: symbol.id,
      source: "internal",
    }));
    unusedExportCount++;
  }
  for (const symbol of dead.testOnlySymbols || []) {
    if (isNonProductPath(symbol.file)) continue;
    findings.push(makeFinding({
      category: "unused",
      rule: "test-only-symbol",
      severity: "low",
      confidence: symbol.publicApi ? "low" : "medium",
      title: `Production symbol used only by tests: ${symbol.label}`,
      detail: `${symbol.reason}. Static analysis cannot rule out external or reflective consumers, so review before removal.`,
      file: symbol.file,
      graphNodeId: symbol.id,
      source: "internal",
      fixHint: "verify production/config consumers, then keep as intentional test support or remove it together with obsolete tests",
    }));
  }

  const supplyChain = await runSupplyChainChecks(repoPath, {
    externalImports,
    packageScopes,
    isNonProductPath,
    advisoryStorePath,
    skipMalwareScan,
    malwareExclusions,
    rgPath,
  });
  findings.push(...supplyChain.findings);
  const sorted = sortFindings(findings);
  const dependencyHealth = buildDependencyHealth({
    repoPath,
    graph,
    repoFiles,
    pyManifest,
    dep,
    goDep,
    pyDep,
    jvmDependencies,
    cargoDep,
    externalImports,
    findings: sorted,
    packageScopes,
    sourceFiles: [...sources.keys()],
    correctnessCoverage: correctness.coverage,
    checks: supplyChain.checks,
  });

  return {
    ok: true,
    engine: "internal",
    repo: basename(repoPath),
    path: repoPath,
    savedAt: new Date().toISOString(),
    scanned: {
      files: dead.stats.files,
      symbols: dead.stats.symbols,
      manifestDeps: dependencyHealth.manifestDeps,
      externalImports: externalImports.length,
      nodeModulesPresent: boundary.resolve("node_modules").ok,
      installedPackages: supplyChain.installedCount,
      advisoryDbDate: supplyChain.advisoryDbDate,
      advisoryStatus: supplyChain.checks.osv.status,
      malwareScanMode: supplyChain.malwareScan?.scanMode || "skipped",
      malwareStatus: supplyChain.checks.malware.status,
      packageScopes: packageScopes.length,
      managedPythonDependencies: managedPython.length,
      nonRuntimeRoots,
      pathClassifications: Object.fromEntries(PATH_CLASS_NAMES.map((name) => [
        name,
        [...pathClassifications.values()].filter((info) => info.classes.includes(name)).length,
      ])),
      pathClassificationExcluded: [...pathClassifications.values()].filter((info) => info.excluded).length,
      conventionEntrypoints: conventionEvidence.length,
    },
    summary: summarizeFindings(sorted),
    findings: sorted,
    dependencyReport: dependencyHealth.dependencyReport,
    deadReport: {
      deadSymbols: dead.deadSymbols.filter((symbol) => !isNonProductPath(symbol.file)).length,
      deadFiles: actionableDeadFiles.length,
      unusedExports: unusedExportCount,
      testOnlySymbols: (dead.testOnlySymbols || []).filter((symbol) => !isNonProductPath(symbol.file)).length,
    },
    conventionReachability: {
      count: conventionEvidence.length,
      entries: conventionEvidence.slice(0, 100),
      truncated: conventionEvidence.length > 100,
    },
    structureReport: structure.stats,
    sourceCorrectnessReport: correctness.coverage,
    healthCapabilities: dependencyHealth.healthCapabilities,
    checks: supplyChain.checks,
    malwareScan: supplyChain.malwareScan,
  };
}
