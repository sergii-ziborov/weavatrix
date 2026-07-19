// Unified Finding factory + rollups for the internal dependency/security engine (DEPS_SECURITY_PLAN.md §2.3).
// Every analyzer (unused / structure / vulnerability / malware) and the external-tool adapter emit THIS shape,
// so the renderer and the AI summarizer consume one contract regardless of engine.
import { createHash } from "node:crypto";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
export const FINDING_CATEGORIES = ["unused", "structure", "vulnerability", "malware"];

export function dependencyVerification(manifest, imports, decision, mapping) {
  return {
    evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE",
    decision,
    manifestDeclaration: { status: "FOUND", file: manifest },
    indexedSourceImports: imports.length
      ? { status: "FOUND", count: imports.length, files: [...new Set(imports.map((item) => item.file))].slice(0, 10) }
      : { status: "ZERO_FOUND", completeness: "COMPLETE_FOR_GRAPH_SCOPE", count: 0, files: [] },
    mapping,
  };
}

// Stable id: survives re-runs so the UI can persist expand/dismiss state per finding.
export function makeFinding(f) {
  const cycleIdentity = Array.isArray(f.cycleMembers)
    ? [...new Set(f.cycleMembers.map(String))].sort().join("\0")
    : "";
  const id = createHash("sha1")
    .update([
      f.category, f.rule, f.file || "", f.manifest || "", f.scope || "",
      f.package || "", f.symbol || "", cycleIdentity, f.title || "",
    ].join("|"))
    .digest("hex")
    .slice(0, 16);
  return {
    id,
    severity: "info",
    confidence: "medium",
    title: "",
    detail: "",
    reason: "",
    file: "",
    line: 0,
    symbol: "",
    package: "",
    version: "",
    graphNodeId: f.graphNodeId || f.file || "",
    evidence: [],
    source: "internal",
    fixHint: "",
    ...f,
  };
}

export function summarizeFindings(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory = { unused: 0, structure: 0, vulnerability: 0, malware: 0 };
  for (const f of findings || []) {
    if (f.severity in bySeverity) bySeverity[f.severity]++;
    if (f.category in byCategory) byCategory[f.category]++;
  }
  return { bySeverity, byCategory };
}

export function sortFindings(findings) {
  const sev = new Map(SEVERITY_ORDER.map((s, i) => [s, i]));
  return [...(findings || [])].sort(
    (a, b) =>
      (sev.get(a.severity) ?? 9) - (sev.get(b.severity) ?? 9) ||
      String(a.category).localeCompare(String(b.category)) ||
      String(a.file || a.package || "").localeCompare(String(b.file || b.package || ""))
  );
}
