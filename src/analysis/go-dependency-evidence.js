import { dirname } from "node:path";
import { createRepoBoundary } from "../repo-path.js";
import { computeGoDepFindings } from "./dep-check-ecosystems.js";
import { listRepoFiles, readRepoText } from "./internal-audit.collect.js";
import { parseGoMod } from "./manifests.js";
import { makeFinding } from "./findings.js";

const rootOf = (file) => {
  const root = dirname(String(file || "").replace(/\\/g, "/"));
  return root === "." ? "" : root;
};
const owns = (root, file) => !root || file === root || String(file || "").replace(/\\/g, "/").startsWith(`${root}/`);

export function collectGoDependencyEvidence(repoRoot, { files = listRepoFiles(repoRoot), externalImports = [], nonRuntimeRoots = [] } = {}) {
  const boundary = createRepoBoundary(repoRoot);
  const manifests = files.filter((file) => /(^|\/)go\.mod$/i.test(file));
  const scopes = manifests.map((file) => ({ file, root: rootOf(file), parsed: parseGoMod(readRepoText(boundary, file)) }))
    .sort((left, right) => right.root.length - left.root.length || left.root.localeCompare(right.root));
  const importsByScope = new Map(scopes.map((scope) => [scope, []]));
  for (const entry of externalImports) {
    if (entry.ecosystem !== "Go") continue;
    const owner = scopes.find((scope) => owns(scope.root, entry.file));
    if (owner) importsByScope.get(owner).push(entry);
  }
  const findings = [], declared = new Set(), issues = [];
  if (!scopes.length) {
    const missing = new Map();
    for (const entry of externalImports.filter((item) => item.ecosystem === "Go" && item.pkg && !item.builtin && !item.unresolved)) {
      if (!missing.has(entry.pkg)) missing.set(entry.pkg, entry);
    }
    for (const [name, entry] of missing) findings.push(makeFinding({
      category: "unused", rule: "missing-dep", severity: "low", confidence: "high",
      title: `Go import without a module manifest: ${name}`,
      reason: "An indexed external Go import exists, but no go.mod was discovered.",
      detail: `"${entry.spec || name}" is imported by ${entry.file}, but no go.mod exists in the repository.`,
      package: name, file: entry.file, line: entry.line || 0, source: "internal",
      verification: { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "ACTION_REQUIRED", manifestDeclaration: { status: "NOT_PRESENT" }, indexedSourceImports: { status: "FOUND", count: 1, files: [entry.file] }, mapping: "Go module prefix" },
      fixHint: "initialize or restore the owning Go module manifest",
    }));
  }
  for (const scope of scopes) {
    if (!scope.parsed.module) issues.push(`${scope.file}: module directive is missing or unreadable`);
    const result = computeGoDepFindings({ externalImports: importsByScope.get(scope), goMod: scope.parsed, nonRuntimeRoots });
    findings.push(...result.findings.map((finding) => ({
      ...finding,
      manifest: scope.file,
      verification: finding.rule === "missing-dep"
        ? { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "ACTION_REQUIRED", manifestDeclaration: { status: "NOT_FOUND", file: scope.file }, indexedSourceImports: { status: "FOUND", count: finding.evidence?.length || 1, files: (finding.evidence || []).map((item) => item.file) }, mapping: "longest go.mod module prefix" }
        : { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "REVIEW_REQUIRED", manifestDeclaration: { status: "FOUND", file: scope.file }, indexedSourceImports: { status: "ZERO_FOUND", completeness: "COMPLETE_FOR_GRAPH_SCOPE", count: 0, files: [] }, mapping: "longest go.mod module prefix" },
    })));
    for (const name of result.declared) declared.add(`${scope.root || "."}:${name}`);
  }
  const present = manifests.length > 0;
  return {
    present,
    status: present ? "CHECKED" : "NOT_PRESENT",
    completeness: present ? (issues.length ? "PARTIAL" : "COMPLETE") : "NOT_APPLICABLE",
    manifests,
    declared,
    findings,
    reasons: issues,
    reason: !present
      ? "No go.mod was discovered."
      : issues.length
        ? `Go imports and requirements were checked across ${manifests.length} module(s), but ${issues.length} module descriptor(s) were incomplete.`
        : `Every discovered go.mod scope (${manifests.length}) was compared with indexed Go imports, including direct/indirect requirements and replace directives.`,
  };
}
