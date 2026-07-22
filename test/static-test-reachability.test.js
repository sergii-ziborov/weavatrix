import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { computeStaticTestReachability } from "../src/analysis/static-test-reachability.js";
import { loadGraph } from "../src/mcp/graph-context.mjs";
import { tCoverageMap } from "../src/mcp/tools-health.mjs";

const fixtureGraph = () => ({
  nodes: [
    "test-e2e/cypress/e2e/app.cy.ts", "test/core.test.ts", "src/feature.ts", "src/core.ts",
    "src/types.ts", "src/unrelated.ts", "src/mockData.ts", "docs/architecture.md",
  ].map((file) => ({ id: file, source_file: file, file_type: "code" })),
  links: [
    { source: "test-e2e/cypress/e2e/app.cy.ts", target: "src/feature.ts", relation: "imports", confidence: "EXTRACTED" },
    { source: "src/feature.ts", target: "src/core.ts", relation: "calls", confidence: "INFERRED" },
    { source: "test/core.test.ts", target: "src/core.ts", relation: "imports", confidence: "EXTRACTED" },
    { source: "test/core.test.ts", target: "src/types.ts", relation: "imports", typeOnly: true, confidence: "EXTRACTED" },
  ],
});

test("static test reachability follows runtime direction, reports nearest tests and never claims coverage", () => {
  const result = computeStaticTestReachability(fixtureGraph());
  assert.equal(result.kind, "staticTestReachability");
  assert.equal(result.actualCoverage, "NOT_AVAILABLE");
  assert.equal(result.testFiles, 2, "Cypress and unit test roots are both seeds");
  assert.ok(!result.reachable.some((entry) => /mockData|docs\//.test(entry.file)), "non-product classifications are not coverage targets");
  const feature = result.reachable.find((entry) => entry.file === "src/feature.ts");
  assert.deepEqual(feature.nearestTests[0], {
    test: "test-e2e/cypress/e2e/app.cy.ts",
    distance: 1,
    score: 3,
    confidence: "HIGH",
    path: ["test-e2e/cypress/e2e/app.cy.ts", "src/feature.ts"],
  });
  const core = result.reachable.find((entry) => entry.file === "src/core.ts");
  assert.equal(core.nearestTests[0].test, "test/core.test.ts");
  assert.equal(core.nearestTests[0].distance, 1);
  assert.equal(core.nearestTests[0].confidence, "HIGH");
  assert.ok(core.nearestTests.some((near) => near.test.includes("app.cy") && near.confidence === "MEDIUM"));
  assert.ok(result.unreachable.includes("src/types.ts"), "type-only imports are not runtime reachability");
  assert.ok(result.unreachable.includes("src/unrelated.ts"));
});

test("static test reachability self-covers inline-test files without over-claiming reach through their production edges", () => {
  // Rust-style layout: production files carry their own `#[cfg(test)]` symbols (test_surface), no separate
  // test/ directory. analyze.rs has inline tests AND a production analyze() that calls bss.rs#parse; bss.rs
  // has no inline test. The inline test does NOT call bss, so bss must NOT be claimed test-reachable just
  // because a *production* symbol in the test-bearing file calls it.
  const graph = {
    nodes: [
      { id: "src/analyze.rs#analyze@1", source_file: "src/analyze.rs", file_type: "code" },
      { id: "src/analyze.rs#tests@40", source_file: "src/analyze.rs", file_type: "code", test_surface: true },
      { id: "src/analyze.rs#checks_analyze@45", source_file: "src/analyze.rs", file_type: "code", test_surface: true },
      { id: "src/bss.rs#parse@1", source_file: "src/bss.rs", file_type: "code" },
      { id: "src/untested.rs#lonely@1", source_file: "src/untested.rs", file_type: "code" },
    ],
    links: [
      // a PRODUCTION-to-production edge; no test_surface symbol has an out-edge here.
      { source: "src/analyze.rs#analyze@1", target: "src/bss.rs#parse@1", relation: "calls", confidence: "INFERRED" },
    ],
  };
  const result = computeStaticTestReachability(graph);
  assert.equal(result.testFiles, 1, "the inline-test file is counted as a test-bearing file");
  const analyze = result.reachable.find((entry) => entry.file === "src/analyze.rs");
  assert.ok(analyze && analyze.nearestTests[0].distance === 0, "a file carrying its own inline tests is self-covered at distance 0");
  assert.ok(result.unreachable.includes("src/bss.rs"), "bss.rs is reached only by a production call, not by any test, so it stays unreachable (no over-claim)");
  assert.ok(result.unreachable.includes("src/untested.rs"), "a file no test reaches stays unreachable");
});

test("coverage_map labels the no-report fallback and a real report wins", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-static-coverage-"));
  try {
    const graph = fixtureGraph();
    for (const node of graph.nodes) {
      const full = join(repo, node.source_file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "export const value = 1;\n");
    }
    const graphPath = join(repo, "graph.json");
    writeFileSync(graphPath, JSON.stringify(graph));
    const fallback = tCoverageMap(loadGraph(graphPath), { top_n: 5 }, { repoRoot: repo, graphPath });
    assert.match(fallback, /Static test reachability/);
    assert.match(fallback, /actualCoverage: NOT_AVAILABLE/);
    assert.match(fallback, /path: test\/core\.test\.ts → src\/core\.ts/);
    assert.match(fallback, /This is NOT coverage/);

    mkdirSync(join(repo, "coverage"));
    writeFileSync(join(repo, "coverage", "coverage-summary.json"), JSON.stringify({
      "src/feature.ts": { lines: { total: 10, covered: 8, pct: 80 } },
    }));
    const measured = tCoverageMap(loadGraph(graphPath), { top_n: 5 }, { repoRoot: repo, graphPath });
    assert.match(measured, /^Coverage map \(/);
    assert.doesNotMatch(measured, /Static test reachability|actualCoverage: NOT_AVAILABLE/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
