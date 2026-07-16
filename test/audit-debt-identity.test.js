import test from "node:test";
import assert from "node:assert/strict";
import { makeFinding } from "../src/analysis/findings.js";
import { compareAuditDebt } from "../src/analysis/audit-debt.js";
import { computeStructureFindings } from "../src/analysis/dep-rules.js";

test("audit debt identity distinguishes the same package finding in two workspace manifests", () => {
  const finding = (scope) => makeFinding({
    category: "unused",
    rule: "unused-dep",
    severity: "low",
    package: "same-package",
    title: "Possibly unused dependency: same-package",
    scope,
    manifest: `${scope}/package.json`,
  });
  const baseline = finding("apps/a");
  const current = finding("apps/b");

  assert.notEqual(baseline.id, current.id);
  const comparison = compareAuditDebt(
    { findings: [current], checks: {} },
    { findings: [baseline], checks: {} },
  );
  assert.deepEqual(comparison.new.map((item) => item.manifest), ["apps/b/package.json"]);
  assert.deepEqual(comparison.fixed.map((item) => item.manifest), ["apps/a/package.json"]);
  assert.equal(comparison.existing.length, 0);
});

test("cycle debt identity includes the full stable SCC membership", () => {
  const graph = (third) => ({
    nodes: ["src/a.js", "src/b.js", third].map((id) => ({ id, source_file: id })),
    links: [
      { source: "src/a.js", target: "src/b.js", relation: "imports" },
      { source: "src/b.js", target: third, relation: "imports" },
      { source: third, target: "src/a.js", relation: "imports" },
    ],
  });
  const first = computeStructureFindings(graph("src/c.js")).findings.find((item) => item.rule === "circular-dep");
  const second = computeStructureFindings(graph("src/d.js")).findings.find((item) => item.rule === "circular-dep");

  assert.equal(first.file, second.file, "both representative cycles are anchored at the same file");
  assert.equal(first.title, second.title, "both tangles have the same size/title");
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.cycleMembers, ["src/a.js", "src/b.js", "src/c.js"]);
  assert.deepEqual(second.cycleMembers, ["src/a.js", "src/b.js", "src/d.js"]);
});
