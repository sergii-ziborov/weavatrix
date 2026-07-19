import { existsSync, readFileSync } from "node:fs";
import { createRepoBoundary } from "../repo-path.js";

const REPORT_PATHS = [
  ".weavatrix/reports/cargo-audit.json",
  ".weavatrix/cargo-audit.json",
  "cargo-audit.json",
];

const warningEntries = (warnings) => Object.entries(warnings || {}).flatMap(([kind, value]) =>
  (Array.isArray(value) ? value : value?.list || []).map((item) => ({ kind, ...item })));

// Imports an explicitly generated `cargo audit --json` report. Core never runs Cargo, downloads the
// RustSec database, or executes repository code; an absent/stale report remains visibly incomplete.
export function loadRustAdvisoryReport(repoPath, { now = Date.now(), maxAgeDays = 30 } = {}) {
  const boundary = createRepoBoundary(repoPath);
  if (!boundary.root) return { status: "ERROR", detail: "Repository boundary is unavailable.", findings: [] };
  const found = REPORT_PATHS.map((file) => ({ file, resolved: boundary.resolve(file) }))
    .find((item) => item.resolved.ok && existsSync(item.resolved.path));
  if (!found) return {
    status: "NOT_CHECKED",
    detail: "No saved cargo audit --json report was found; Cargo.lock OSV matching is separate evidence.",
    findings: [],
  };
  try {
    const report = JSON.parse(readFileSync(found.resolved.path, "utf8"));
    const vulnerabilities = report?.vulnerabilities?.list;
    if (!Array.isArray(vulnerabilities)) throw new Error("vulnerabilities.list is missing");
    const checkedAt = report?.database?.["last-updated"] || report?.database?.lastUpdated || report?.generatedAt || null;
    const ageMs = checkedAt ? now - new Date(checkedAt).getTime() : Number.POSITIVE_INFINITY;
    const stale = !Number.isFinite(ageMs) || ageMs > maxAgeDays * 86_400_000;
    const findings = vulnerabilities.map((item) => ({
      kind: "vulnerability",
      id: item.advisory?.id || "RUSTSEC-UNKNOWN",
      title: item.advisory?.title || item.advisory?.description || "RustSec advisory",
      url: item.advisory?.url || "",
      package: item.package?.name || item.advisory?.package || "unknown-crate",
      version: item.package?.version || "",
      patched: item.versions?.patched || [],
    }));
    findings.push(...warningEntries(report?.warnings).map((item) => ({
      kind: item.kind || "warning",
      id: item.advisory?.id || `cargo-audit-${item.kind || "warning"}`,
      title: item.advisory?.title || item.message || `Cargo audit ${item.kind || "warning"}`,
      url: item.advisory?.url || "",
      package: item.package?.name || item.advisory?.package || "unknown-crate",
      version: item.package?.version || "",
      patched: item.versions?.patched || [],
    })));
    return {
      status: stale ? "PARTIAL" : "OK",
      detail: `${stale ? "Imported stale/undated" : "Imported"} cargo-audit report ${found.file}: ${vulnerabilities.length} vulnerability/vulnerabilities and ${findings.length - vulnerabilities.length} warning(s).`,
      checkedAt,
      file: found.file,
      findings,
    };
  } catch (error) {
    return { status: "ERROR", detail: `Could not read ${found.file}: ${error instanceof Error ? error.message : String(error)}`, file: found.file, findings: [] };
  }
}
