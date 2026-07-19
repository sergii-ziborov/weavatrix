// Honest Health capability coverage. `status` says whether a check actually ran for this repository;
// `completeness` says whether its evidence can support a repository-wide conclusion.
const capability = (status, completeness, detail, extra = {}) => ({ status, completeness, detail, ...extra });

const sourceLanguages = (files) => {
  const languages = new Set();
  for (const file of files || []) {
    if (/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i.test(file)) languages.add("javascript/typescript");
    else if (/\.py$/i.test(file)) languages.add("python");
    else if (/\.go$/i.test(file)) languages.add("go");
    else if (/\.java$/i.test(file)) languages.add("java");
    else if (/\.rs$/i.test(file)) languages.add("rust");
    else if (/\.cs$/i.test(file)) languages.add("csharp");
  }
  return languages;
};

const checkCapability = (check, supported, label) => {
  if (!supported) return capability("NOT_SUPPORTED", "PARTIAL", `${label} is not supported for the discovered package ecosystem.`);
  if (check?.status === "OK") return capability("CHECKED", "COMPLETE", check.detail || `${label} completed.`);
  if (check?.status === "PARTIAL") return capability("NOT_CHECKED", "PARTIAL", check.detail || `${label} evidence is partial.`);
  if (check?.status === "ERROR") return capability("NOT_CHECKED", "PARTIAL", check.detail || `${label} failed.`);
  return capability("NOT_CHECKED", "PARTIAL", check?.detail || `${label} was not requested.`);
};

export function buildHealthCapabilityMatrix({
  graphComplete,
  dependencyStatus,
  dependencyEcosystems = {},
  checks = {},
  sourceFiles = [],
  correctnessCoverage = {},
  measuredCoverageFiles = 0,
} = {}) {
  const languages = sourceLanguages(sourceFiles);
  const ecosystemRows = Object.values(dependencyEcosystems).filter((item) => item?.present);
  const supportedDependencyRows = ecosystemRows.filter((item) => item.status === "CHECKED");
  const unsupportedDependencyRows = ecosystemRows.filter((item) => item.status === "NOT_SUPPORTED");
  const noDependencyEvidence = ecosystemRows.length === 0;
  const onlyUnsupportedDependencies = unsupportedDependencyRows.length > 0 && supportedDependencyRows.length === 0;
  const advisorySupported = supportedDependencyRows.some((item) => ["npm", "go", "python"].includes(item.ecosystem));
  const malwareSupported = supportedDependencyRows.some((item) => ["npm", "go", "python"].includes(item.ecosystem));
  const coverageSupported = [...languages].some((language) => ["javascript/typescript", "python", "go"].includes(language));
  const runtimeFiles = Number(correctnessCoverage.runtimeCorrectnessFiles || 0);
  const concurrencyFiles = Number(correctnessCoverage.concurrencyFiles || 0);

  return {
    capabilityMatrixV: 1,
    structure: capability(
      "CHECKED",
      graphComplete ? "COMPLETE" : "PARTIAL",
      graphComplete
        ? "Graph cycles, orphans and configured boundaries were checked over the complete graph."
        : "Structure checks ran, but the graph is scoped or excludes part of the repository.",
    ),
    dependencies: capability(
      noDependencyEvidence ? "NOT_CHECKED" : onlyUnsupportedDependencies ? "NOT_SUPPORTED" : "CHECKED",
      !noDependencyEvidence && dependencyStatus === "COMPLETE" ? "COMPLETE" : "PARTIAL",
      noDependencyEvidence
        ? "No dependency manifest was discovered, so manifest-to-import verification did not run."
        : onlyUnsupportedDependencies
        ? "Dependency manifests were detected, but every discovered build ecosystem lacks import-to-artifact verification."
        : unsupportedDependencyRows.length
          ? `Supported ecosystems were checked; ${unsupportedDependencyRows.map((item) => item.ecosystem).join(", ")} remains NOT_SUPPORTED.`
          : "Discovered supported manifests were compared with indexed imports at their documented evidence level.",
      { ecosystems: dependencyEcosystems },
    ),
    runtimeCorrectness: runtimeFiles
      ? capability("CHECKED", "PARTIAL", `Checked ${runtimeFiles} product source file(s) for the bounded Go/Java/retry correctness patterns. This is not compiler or runtime proof.`, { checks: correctnessCoverage.checks || {} })
      : capability("NOT_SUPPORTED", "PARTIAL", "No source file matched the currently supported bounded correctness patterns."),
    concurrency: concurrencyFiles
      ? capability("CHECKED", "PARTIAL", `Checked ${concurrencyFiles} Java source file(s) for direct InterruptedException restore/rethrow evidence. No race detector ran; race freedom is not claimed.`)
      : capability("NOT_SUPPORTED", "PARTIAL", "No supported Java interruption check applied. No race detector ran; race freedom is not claimed."),
    advisories: checkCapability(checks.osv, advisorySupported, "OSV advisory matching"),
    malware: checkCapability(checks.malware, malwareSupported, "Installed-package malware scanning"),
    coverage: measuredCoverageFiles > 0
      ? capability("CHECKED", "COMPLETE", `Mapped an existing supported coverage report to ${measuredCoverageFiles} file(s).`)
      : coverageSupported
        ? capability("NOT_CHECKED", "PARTIAL", "No supported measured coverage report was found; static test reachability is not coverage.")
        : capability("NOT_SUPPORTED", "PARTIAL", `No supported coverage format applies to the discovered language set${languages.size ? ` (${[...languages].join(", ")})` : ""}.`),
  };
}
