// Deterministic health-debt comparison. Supply-chain findings are deliberately excluded: an
// immutable source checkout has no trustworthy per-repository OSV refresh stamp or installed-package
// malware state, so calling those findings new/fixed would manufacture certainty.
const OPTIONAL_CATEGORIES = new Set(["vulnerability", "malware"]);

const normalizePath = (value) => String(value || "").trim()
  .replace(/\\/g, "/")
  .replace(/^\.\//, "")
  .replace(/\/{2,}/g, "/")
  .replace(/\/$/, "");

export function normalizeAuditScopeFiles(input, maxFiles = 500) {
  if (!Array.isArray(input)) return { ok: true, files: null };
  const files = [];
  const seen = new Set();
  for (const raw of input) {
    const file = normalizePath(raw);
    if (!file || file.includes("\0") || file.startsWith("/") || /^[A-Za-z]:\//.test(file) || file === ".." || file.startsWith("../") || file.includes("/../") || file.startsWith("-")) {
      return { ok: false, files: [], error: `changed_files contains an invalid repo-relative path: ${String(raw || "(empty)")}` };
    }
    if (!seen.has(file)) { seen.add(file); files.push(file); }
    if (files.length > maxFiles) return { ok: false, files: [], error: `changed_files exceeds the ${maxFiles}-file safety bound` };
  }
  if (!files.length) return { ok: false, files: [], error: "changed_files was provided but empty" };
  return { ok: true, files: files.sort((a, b) => a.localeCompare(b)) };
}

export function auditFindingFiles(finding) {
  const values = [finding?.file, finding?.manifest, finding?.graphNodeId];
  for (const evidence of finding?.evidence || []) values.push(evidence?.file);
  return [...new Set(values
    .map((value) => normalizePath(String(value || "").split("#", 1)[0]))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

export function findingTouchesAuditScope(finding, changedFiles) {
  if (changedFiles == null) return true;
  const scope = changedFiles instanceof Set ? changedFiles : new Set(changedFiles.map(normalizePath));
  return auditFindingFiles(finding).some((file) => scope.has(file));
}

export function scopeAuditFindings(findings, changedFiles) {
  const scope = changedFiles == null ? null : new Set(changedFiles.map(normalizePath));
  return (findings || []).filter((finding) => findingTouchesAuditScope(finding, scope));
}

const comparable = (findings) => (findings || []).filter((finding) => !OPTIONAL_CATEGORIES.has(finding.category));
const optional = (findings) => (findings || []).filter((finding) => OPTIONAL_CATEGORIES.has(finding.category));

// Findings already carry stable IDs from makeFinding(). Compare globally first, then apply the
// changed-file scope. This prevents pre-existing debt in an edited file from becoming "new".
export function compareAuditDebt(currentAudit, baselineAudit, changedFiles = null, { completeChangeSet = false } = {}) {
  const current = comparable(currentAudit?.findings);
  const baseline = comparable(baselineAudit?.findings);
  const currentIds = new Set(current.map((finding) => String(finding.id)));
  const baselineIds = new Set(baseline.map((finding) => String(finding.id)));
  const scopedCurrent = scopeAuditFindings(current, changedFiles);
  const scopedBaseline = scopeAuditFindings(baseline, changedFiles);
  const globalFresh = current.filter((finding) => !baselineIds.has(String(finding.id)));
  const globalFixedFindings = baseline.filter((finding) => !currentIds.has(String(finding.id)));
  // A complete, automatically derived Git diff is the causal boundary: a new manifest-level finding
  // can be caused by editing only its former importer, so path intersection would hide it. Explicit
  // changed_files may be a subset of other working-tree changes and therefore stays path-scoped.
  const fresh = completeChangeSet ? globalFresh : scopedCurrent.filter((finding) => !baselineIds.has(String(finding.id)));
  const existing = scopedCurrent.filter((finding) => baselineIds.has(String(finding.id)));
  const fixed = completeChangeSet ? globalFixedFindings : scopedBaseline.filter((finding) => !currentIds.has(String(finding.id)));
  const all = [...fresh, ...existing].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const globalNew = globalFresh.length;
  const globalExisting = current.length - globalNew;
  const globalFixed = globalFixedFindings.length;
  return {
    scope: {strategy: completeChangeSet ? "complete-change-set-causality" : "path-intersection"},
    new: fresh,
    existing,
    fixed,
    all: all.map((finding) => ({ ...finding, debtState: baselineIds.has(String(finding.id)) ? "existing" : "new" })),
    optional: {
      current: optional(currentAudit?.findings),
      baseline: optional(baselineAudit?.findings),
      checks: ["osv", "malware"].map((name) => ({
        name,
        status: "UNCOMPARABLE",
        current: currentAudit?.checks?.[name]?.status || "ERROR",
        baseline: baselineAudit?.checks?.[name]?.status || "ERROR",
        reason: "The immutable source checkout cannot reproduce the current advisory-refresh or installed-package scan state.",
      })),
    },
    totals: {
      scope: { new: fresh.length, existing: existing.length, fixed: fixed.length, active: fresh.length + existing.length },
      repository: { new: globalNew, existing: globalExisting, fixed: globalFixed, active: current.length },
    },
  };
}
