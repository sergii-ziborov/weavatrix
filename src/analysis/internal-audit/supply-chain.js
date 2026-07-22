import { collectInstalled } from "../../security/installed.js";
import { advisoryQueryFingerprint, loadStore, queryStore } from "../../security/advisory-store.js";
import { matchAdvisories } from "../../security/match.js";
import { scanMalware } from "../../security/malware-heuristics.js";
import { classifyTyposquat } from "../../security/typosquat.js";
import { loadRustAdvisoryReport } from "../../security/rust-advisory-report.js";
import { makeFinding } from "../findings.js";
import { packageReachability } from "../package-reachability.js";

const LOWER_SEVERITY = { critical: "high", high: "medium", medium: "low", low: "info", info: "info" };

const removalHint = (pkg) => {
  if (pkg?.ecosystem === "npm") return `npm uninstall ${pkg.name} and audit what it touched`;
  if (pkg?.ecosystem === "PyPI") return `remove ${pkg.name} from the Python environment/manifest and audit what it touched`;
  if (pkg?.ecosystem === "Go") return `remove ${pkg.name} from the Go module graph, run go mod tidy, and audit what it touched`;
  if (pkg?.ecosystem === "crates.io") return `cargo remove ${pkg.name}, rebuild every feature/target, and audit what it touched`;
  if (pkg?.ecosystem === "Maven") return `remove or upgrade ${pkg.name} in Maven/Gradle, refresh the resolved graph, and audit what it touched`;
  return `remove ${pkg?.name || "the package"} with its ecosystem's package manager and audit what it touched`;
};

export async function runSupplyChainChecks(repoPath, {
  externalImports = [],
  packageScopes = [],
  isNonProductPath = () => false,
  advisoryStorePath,
  skipMalwareScan = false,
  malwareExclusions = {},
  rgPath = "",
} = {}) {
  const findings = [];
  let advisoryDbDate = null;
  let installedCount = 0;
  let inst = { installed: [], drift: [] };
  const checks = {
    osv: { status: "NOT_CHECKED", detail: "Advisory cache was never refreshed for this repository. The MIT core remains offline; use the separate Weavatrix Online connector only if you choose to query OSV with pinned package names and versions." },
    malware: { status: skipMalwareScan ? "NOT_CHECKED" : "PENDING", detail: skipMalwareScan ? "Installed-package malware scan is opt-in and was not requested." : "" },
    rustsec: { status: "NOT_CHECKED", detail: "No saved cargo audit --json report was inspected." },
  };

  try {
    inst = collectInstalled(repoPath);
    installedCount = inst.installed.length;
    const store = advisoryStorePath ? loadStore(advisoryStorePath) : loadStore();
    const repoStamp = store.meta?.repos?.[repoPath] || null;
    advisoryDbDate = typeof repoStamp === "string" ? repoStamp : repoStamp?.fetched_at || null;
    if (advisoryDbDate) {
      let status = typeof repoStamp === "object" && ["OK", "PARTIAL", "ERROR"].includes(repoStamp.status) ? repoStamp.status : "PARTIAL";
      const fingerprintMatches = typeof repoStamp === "object" && repoStamp.query_fingerprint === advisoryQueryFingerprint(inst.installed);
      if (!fingerprintMatches && status === "OK") status = "PARTIAL";
      const coverage = typeof repoStamp === "object" && Number.isFinite(repoStamp.queried)
        ? ` (${repoStamp.queried_ok ?? repoStamp.queried}/${repoStamp.queried} package versions queried successfully)`
        : "";
      const drift = fingerprintMatches ? "" : " Dependency versions changed, or this is a legacy stamp without a package fingerprint; refresh through the separate Weavatrix Online connector for complete advisory coverage.";
      checks.osv = {
        status,
        detail: `${status === "PARTIAL" ? "Partially matched" : "Matched"} installed packages against the cached OSV snapshot from ${advisoryDbDate}${coverage}.${drift}`,
        checkedAt: advisoryDbDate,
      };
      for (const hit of matchAdvisories(inst.installed, (ecosystem, name) => queryStore(store, ecosystem, name))) {
        const malicious = hit.adv.kind === "malicious";
        const reachability = packageReachability(externalImports, hit.pkg.name, { isNonProductPath });
        const observedInProduct = reachability.state === "DIRECT_RUNTIME_IMPORT";
        const reachabilityDetail = observedInProduct
          ? ` Graph reachability: directly imported by product code in ${reachability.directRuntimeImports} callsite(s) across ${reachability.files.length} file(s).`
          : ` Graph reachability: ${reachability.state}; ${reachability.note}`;
        findings.push(makeFinding({
          category: malicious ? "malware" : "vulnerability",
          rule: malicious ? "malicious-package" : "known-vuln",
          severity: malicious || observedInProduct ? (malicious ? "critical" : hit.adv.severity) : LOWER_SEVERITY[hit.adv.severity] || hit.adv.severity,
          confidence: malicious || observedInProduct ? hit.confidence : "low",
          title: `${malicious ? "Known-malicious package" : `Known vulnerability (${hit.adv.id})`}: ${hit.pkg.name}@${hit.pkg.version}`,
          detail: `${hit.adv.summary || hit.adv.id}${hit.adv.fixedIn.length ? ` Fixed in: ${hit.adv.fixedIn.join(", ")}.` : malicious ? " Remove this package immediately and rotate any secrets it could reach." : ""} (matched by ${hit.matchedBy}${hit.adv.aliases.length ? `; aliases ${hit.adv.aliases.join(", ")}` : ""}).${reachabilityDetail}`,
          package: hit.pkg.name,
          version: hit.pkg.version,
          reachability,
          evidence: [
            { file: hit.adv.id, line: 0, snippet: `installed via ${hit.pkg.source}${hit.pkg.dev ? " (dev)" : ""}` },
            ...reachability.evidence.slice(0, 5).map((item) => ({ file: item.file, line: item.line, snippet: `${item.typeOnly ? "type-only " : ""}${item.kind}` })),
          ],
          source: "osv",
          fixHint: malicious
            ? removalHint(hit.pkg)
            : hit.adv.fixedIn.length
              ? `upgrade ${hit.pkg.name} to ${hit.adv.fixedIn.at(-1)}+ with its ecosystem's package manager`
              : "no fixed version published; consider replacing the package",
        }));
      }
    }
    const directDependencyNames = new Set(packageScopes.flatMap((scope) => Object.keys({ ...(scope.pkg?.dependencies || {}), ...(scope.pkg?.devDependencies || {}) })));
    for (const name of directDependencyNames) {
      const candidate = classifyTyposquat(name);
      if (!candidate) continue;
      findings.push(makeFinding({
        category: "malware",
        rule: "typosquat",
        severity: "medium",
        confidence: "low",
        title: `Possible typosquat: ${name} (looks like "${candidate.nearest}")`,
        detail: `Direct dependency "${name}" is edit-distance ${candidate.distance} from the popular package "${candidate.nearest}". Confirm you meant "${name}" and not "${candidate.nearest}" — name-confusion is a common supply-chain lure.`,
        package: name,
        source: "internal",
        fixHint: `verify "${name}" is the intended package (not a typo of "${candidate.nearest}")`,
      }));
    }
    for (const item of inst.drift.slice(0, 20)) {
      findings.push(makeFinding({
        category: "malware",
        rule: "lockfile-drift",
        severity: "low",
        confidence: "medium",
        title: `Lockfile drift: ${item.name} (locked ${item.locked}, installed ${item.installed})`,
        detail: "The version on disk differs from the lockfile — a stale install, a manual edit, or (worst case) tampering. Reinstall from the lockfile to realign.",
        package: item.name,
        version: item.installed,
        source: "internal",
        fixHint: "npm ci (clean install from the lockfile)",
      }));
    }
    const rustsec = loadRustAdvisoryReport(repoPath);
    checks.rustsec = { status: rustsec.status, detail: rustsec.detail, checkedAt: rustsec.checkedAt || null };
    for (const issue of rustsec.findings) {
      findings.push(makeFinding({
        category: "vulnerability", rule: issue.kind === "vulnerability" ? "known-vuln" : "rust-advisory-warning",
        severity: issue.kind === "vulnerability" ? "high" : "medium", confidence: "high",
        title: `${issue.id}: ${issue.package}${issue.version ? `@${issue.version}` : ""}`,
        detail: `${issue.title}${issue.patched.length ? ` Patched: ${issue.patched.join(", ")}.` : ""}`,
        package: issue.package, version: issue.version, source: "rustsec",
        evidence: issue.url ? [{ file: issue.url, line: 0, snippet: `imported from ${rustsec.file}` }] : [{ file: rustsec.file, line: 0, snippet: issue.id }],
        fixHint: issue.patched.length ? `upgrade ${issue.package} to a patched RustSec range (${issue.patched.join(", ")})` : `review or replace ${issue.package}; no patched range was reported`,
      }));
    }
  } catch (error) {
    checks.osv = { status: "ERROR", detail: `Offline advisory matching failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  let malwareScan = null;
  if (!skipMalwareScan) {
    try {
      const importedPkgs = new Set(externalImports.filter((entry) => entry.pkg && !entry.builtin).map((entry) => entry.pkg));
      const scan = await scanMalware(repoPath, { installed: inst.installed, importedPkgs, malwareExclusions, rgPath });
      findings.push(...scan.findings);
      malwareScan = { scanMode: scan.scanMode, packagesScanned: scan.packagesScanned, findings: scan.findings.length, excludedSignals: scan.excludedSignals || 0 };
      checks.malware = { status: "OK", detail: `Scanned ${scan.packagesScanned} installed package(s) using ${scan.scanMode}.` };
    } catch (error) {
      checks.malware = { status: "ERROR", detail: `Installed-package malware scan failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { findings, checks, installedCount, advisoryDbDate, malwareScan };
}
