import { readCoverageForRepo } from "../coverage-reports.js";
import { buildHealthCapabilityMatrix } from "../health-capabilities.js";

export function buildDependencyHealth({
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
  findings,
  packageScopes,
  sourceFiles,
  correctnessCoverage,
  checks,
}) {
  const dependencyFindings = findings.filter((finding) => ["unused-dep", "missing-dep", "duplicate-dep"].includes(finding.rule));
  const graphComplete = !((graph.graphBuildMode && graph.graphBuildMode !== "full") || graph.graphBuildScope);
  const npmManifests = repoFiles.filter((file) => /(^|\/)package\.json$/i.test(file));
  const pythonManifests = [...new Set((pyManifest.scopes || []).flatMap((scope) => scope.manifests || []))];
  const publicEvidence = ({ findings: _findings, ...item }) => item;
  const ecosystems = {
    npm: {
      ecosystem: "npm",
      present: npmManifests.length > 0,
      status: npmManifests.length ? "CHECKED" : "NOT_PRESENT",
      completeness: graphComplete ? "COMPLETE" : "PARTIAL",
      manifests: npmManifests,
      declared: dep.declared.size,
      reason: npmManifests.length
        ? "package.json declarations were compared with indexed JavaScript/TypeScript imports, including per-finding manifest/source/config evidence."
        : "No package.json was discovered.",
    },
    go: {
      ecosystem: "go",
      present: goDep.present,
      status: goDep.status,
      completeness: graphComplete && goDep.completeness === "COMPLETE" ? "COMPLETE" : goDep.completeness,
      manifests: goDep.manifests,
      declared: goDep.declared.size,
      reason: goDep.reason,
    },
    python: {
      ecosystem: "python",
      present: pyManifest.present,
      status: pyManifest.present ? "CHECKED" : "NOT_PRESENT",
      completeness: pyManifest.present ? (graphComplete && pyManifest.completeness === "COMPLETE" ? "COMPLETE" : "PARTIAL") : "NOT_APPLICABLE",
      manifests: pythonManifests,
      declared: pyDep.declared.size,
      reason: pyManifest.present
        ? pyManifest.reasons?.length
          ? `Python declarations were compared with indexed imports, but ${pyManifest.reasons.join("; ")}.`
          : "Every discovered supported Python manifest scope was compared with indexed imports. Environment markers and extras are normalized as declarations; runtime-computed imports remain outside static proof."
        : "No supported Python dependency manifest was discovered.",
    },
    maven: { ecosystem: "maven", ...publicEvidence(jvmDependencies.maven), completeness: jvmDependencies.maven.present && !graphComplete ? "PARTIAL" : jvmDependencies.maven.completeness },
    gradle: { ecosystem: "gradle", ...publicEvidence(jvmDependencies.gradle), completeness: jvmDependencies.gradle.present && !graphComplete ? "PARTIAL" : jvmDependencies.gradle.completeness },
    rust: { ecosystem: "rust", ...publicEvidence(cargoDep), declared: cargoDep.declared.size, completeness: cargoDep.present && !graphComplete ? "PARTIAL" : cargoDep.completeness },
  };
  const present = Object.values(ecosystems).filter((item) => item.present);
  const status = present.length === 0
    ? "NOT_CHECKED"
    : graphComplete && present.every((item) => item.status === "CHECKED" && item.completeness === "COMPLETE")
      ? "COMPLETE"
      : "PARTIAL";
  const importedPackages = new Set(externalImports
    .filter((entry) => entry?.pkg && !entry.builtin && !entry.unresolved)
    .map((entry) => `${entry.ecosystem || (/\.java$/i.test(entry.file || "") ? "maven-unresolved" : "npm")}:${entry.pkg}`));
  const supportedDeclared = dep.declared.size + goDep.declared.size + pyDep.declared.size + cargoDep.declared.size;
  const jvmDeclared = jvmDependencies.maven.declared + jvmDependencies.gradle.declared;
  const measuredCoverage = readCoverageForRepo(repoPath, sourceFiles);
  const healthCapabilities = buildHealthCapabilityMatrix({
    graphComplete,
    dependencyStatus: status,
    dependencyEcosystems: ecosystems,
    checks,
    sourceFiles,
    correctnessCoverage,
    measuredCoverageFiles: measuredCoverage.size,
  });
  return {
    manifestDeps: supportedDeclared + jvmDeclared,
    healthCapabilities,
    dependencyReport: {
      status,
      evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE",
      perFindingVerification: present.some((item) => item.status === "CHECKED")
        && dependencyFindings.every((finding) => finding.verification != null),
      verificationCoverage: Object.fromEntries(present.map((item) => [item.ecosystem, `${item.status}/${item.completeness}`])),
      ecosystems,
      declared: supportedDeclared + jvmDeclared,
      importedPackages: importedPackages.size,
      importRecords: externalImports.length,
      unused: dependencyFindings.filter((finding) => finding.rule === "unused-dep").length,
      missing: dependencyFindings.filter((finding) => finding.rule === "missing-dep").length,
      duplicateDeclarations: dependencyFindings.filter((finding) => finding.rule === "duplicate-dep").length,
      unusedRequiringReview: dependencyFindings.filter((finding) => finding.rule === "unused-dep" && finding.verification?.decision === "REVIEW_REQUIRED").length,
      missingWithSourceEvidence: dependencyFindings.filter((finding) => finding.rule === "missing-dep" && finding.verification?.indexedSourceImports?.status === "FOUND").length,
      packageScopes: packageScopes.length,
      reason: status === "NOT_CHECKED"
        ? "No dependency manifest was discovered, so manifest-to-import verification did not run and no dependency verdict was produced."
        : status === "COMPLETE"
        ? "Every discovered dependency ecosystem has complete supported manifest-to-import evidence for the indexed repository."
        : present.some((item) => item.status === "NOT_SUPPORTED")
          ? `Dependency evidence is PARTIAL: ${present.filter((item) => item.status === "NOT_SUPPORTED").map((item) => item.ecosystem).join(", ")} manifests were counted, but package-to-artifact verification is NOT_SUPPORTED.`
          : "Dependency checks ran at their documented evidence level, but at least one graph or ecosystem surface is partial; this is not a repository-wide clean bill.",
    },
  };
}
