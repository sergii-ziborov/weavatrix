import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGraph } from "../src/mcp/graph-context.mjs";
import { tChangeImpact } from "../src/mcp/tools-impact.mjs";

const fileNode = (file) => ({ id: file, label: file, source_file: file, file_type: "code" });
const symbolNode = (file, name, start, end, extra = {}) => ({
  id: `${file}#${name}@${start}`,
  label: `${name}()`,
  source_file: file,
  source_location: `L${start}`,
  source_end: `L${end}`,
  file_type: "code",
  ...extra,
});

function fixtureGraph() {
  const legacyImporters = Array.from({ length: 12 }, (_, index) => `src/legacy-${index}.ts`);
  return {
    nodes: [
      fileNode("src/api.ts"),
      symbolNode("src/api.ts", "legacyApi", 1, 4, { exported: true }),
      symbolNode("src/api.ts", "useRetentionPolicy", 10, 14, { exported: true }),
      fileNode("src/consumer.ts"),
      symbolNode("src/consumer.ts", "renderPolicy", 1, 5, { exported: true }),
      fileNode("test/consumer.test.ts"),
      ...legacyImporters.map(fileNode),
    ],
    links: [
      { source: "src/api.ts", target: "src/api.ts#legacyApi@1", relation: "contains" },
      { source: "src/api.ts", target: "src/api.ts#useRetentionPolicy@10", relation: "contains" },
      { source: "src/consumer.ts", target: "src/consumer.ts#renderPolicy@1", relation: "contains" },
      { source: "src/consumer.ts#renderPolicy@1", target: "src/api.ts#useRetentionPolicy@10", relation: "calls", confidence: "EXTRACTED" },
      { source: "test/consumer.test.ts", target: "src/consumer.ts#renderPolicy@1", relation: "calls", confidence: "EXTRACTED" },
      ...legacyImporters.map((file) => ({ source: file, target: "src/api.ts", relation: "imports", confidence: "EXTRACTED" })),
    ],
  };
}

function withFixture(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "weavatrix-change-impact-"));
  const graphPath = join(repoRoot, "graph.json");
  const graph = fixtureGraph();
  writeFileSync(graphPath, JSON.stringify(graph));
  try {
    return run(loadGraph(graphPath), { repoRoot, graphPath });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const additiveDiff = [
  "diff --git a/src/api.ts b/src/api.ts",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -4,0 +10,5 @@",
  "+export function useRetentionPolicy(value) {",
  "+  const retained = value?.retained ?? false;",
  "+  if (!retained) return null;",
  "+  return { retained };",
  "+}",
].join("\n");

test("change_impact keeps a pure additive API change LOW and does not inherit legacy file importers", () => {
  withFixture((graph, ctx) => {
    const value = tChangeImpact(graph, { diff: additiveDiff }, ctx);
    assert.equal(value.__weavatrixToolResult, true);
    assert.match(value.text, /^LOW/);
    assert.equal(value.result.status, "COMPLETE");
    assert.equal(value.result.verdict, "LOW");
    assert.deepEqual(value.result.seeds.ids, []);
    assert.equal(value.result.blastRadius.impacted, 0);
    assert.equal(value.result.blastRadius.nodes.length, 0);
    assert.ok(!value.text.includes("legacy-"));
    assert.equal(value.result.testEvidence.actualCoverage, "NOT_AVAILABLE");
    assert.equal(value.result.testEvidence.staticTestReachability.kind, "staticTestReachability");
  });
});

test("change_impact overlays static test reachability without claiming measured coverage", () => {
  const bodyDiff = [
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -12 +12 @@",
    "-  if (!retained) return null;",
    "+  if (!retained) return undefined;",
  ].join("\n");
  withFixture((graph, ctx) => {
    const value = tChangeImpact(graph, { diff: bodyDiff }, ctx);
    assert.equal(value.result.verdict, "MEDIUM");
    assert.deepEqual(value.result.seeds.ids, ["src/api.ts#useRetentionPolicy@10"]);
    const caller = value.result.blastRadius.nodes.find((node) => node.id === "src/consumer.ts#renderPolicy@1");
    assert.ok(caller, "the exact symbol caller should be in the blast radius");
    assert.equal(caller.testEvidence.actualCoverage, null);
    assert.deepEqual(caller.testEvidence.staticTestReachability, {
      status: "REACHABLE",
      test: "test/consumer.test.ts",
      distance: 1,
      confidence: "HIGH",
      path: ["test/consumer.test.ts", "src/consumer.ts"],
    });
    assert.equal(value.result.testEvidence.actualCoverage, "NOT_AVAILABLE");
    assert.deepEqual(value.result.testEvidence.changedFiles, [{
      file: "src/api.ts",
      actualCoverage: null,
      staticTestReachability: {
        status: "REACHABLE",
        test: "test/consumer.test.ts",
        distance: 2,
        confidence: "HIGH",
        path: ["test/consumer.test.ts", "src/consumer.ts", "src/api.ts"],
      },
    }]);
  });
});

test("change_impact preserves explicit files as a conservative no-diff fallback", () => {
  withFixture((graph, ctx) => {
    const value = tChangeImpact(graph, { files: ["src/api.ts"] }, ctx);
    assert.match(value.text, /^HIGH/);
    assert.equal(value.result.status, "PARTIAL");
    assert.equal(value.result.verdict, "HIGH");
    assert.ok(value.result.seeds.ids.includes("src/api.ts"));
    assert.ok(value.result.seeds.ids.includes("src/api.ts#legacyApi@1"));
    assert.equal(value.result.blastRadius.nodes.filter((node) => node.id.startsWith("src/legacy-")).length, 12);
    assert.equal(value.completeness.status, "PARTIAL");
  });
});
