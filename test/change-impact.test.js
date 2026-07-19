import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadGraph } from "../src/mcp/graph-context.mjs";
import { tChangeImpact } from "../src/mcp/tools-impact.mjs";
import { buildInternalGraph } from "../src/graph/internal-builder.js";

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

test("change_impact batches exact direct references for changed TypeScript symbols", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "weavatrix-change-impact-lsp-"));
  mkdirSync(join(repoRoot, "src"), {recursive: true});
  const apiText = "export function policy(value: number) {\n  return value + 1;\n}\n";
  const callerText = "import {policy} from './api';\nexport function render() { return policy(1); }\n";
  writeFileSync(join(repoRoot, "tsconfig.json"), JSON.stringify({include: ["src/**/*.ts"]}));
  writeFileSync(join(repoRoot, "src", "api.ts"), apiText);
  writeFileSync(join(repoRoot, "src", "caller.ts"), callerText);
  try {
    const raw = {...await buildInternalGraph(repoRoot), graphBuildMode: "full", graphBuildScope: "", graphPrecisionMode: "lsp"};
    const graphPath = join(repoRoot, "graph.json");
    writeFileSync(graphPath, JSON.stringify(raw));
    const graph = loadGraph(graphPath);
    const target = raw.nodes.find((node) => node.source_file === "src/api.ts" && node.label === "policy()");
    const diff = [
      "diff --git a/src/api.ts b/src/api.ts",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -2 +2 @@",
      "-  return value;",
      "+  return value + 1;",
    ].join("\n");
    const character = callerText.split("\n")[1].lastIndexOf("policy");
    const clientFactory = async () => ({
      provider: "fake-batch-lsp",
      version: "1.0.0",
      async openDocument() {},
      async references() {
        return [{
          uri: pathToFileURL(join(repoRoot, "src", "caller.ts")).href,
          range: {start: {line: 1, character}, end: {line: 1, character: character + 6}},
        }];
      },
      async close() {},
    });
    const value = await tChangeImpact(graph, {diff, precision: "lsp"}, {
      repoRoot, graphPath, precisionClientFactory: clientFactory,
    });
    assert.equal(value.result.semanticPrecision.status, "DIRECT_EXACT_TRANSITIVE_GRAPH");
    assert.deepEqual(value.result.semanticPrecision.verifiedTargets, [target.id]);
    assert.equal(value.result.semanticPrecision.exactDirectEdges, 1);
    assert.match(value.text, /EXACT_LSP verified direct references for 1\/1/);
    assert.ok(value.result.blastRadius.nodes.some((node) => node.id.includes("#render@")));
  } finally { rmSync(repoRoot, {recursive: true, force: true}); }
});
