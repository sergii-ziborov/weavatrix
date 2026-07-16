import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeDeadCodeReview } from "../src/analysis/dead-code-review.js";
import { tFindDeadCode } from "../src/mcp/tools-health.mjs";

const fileNode = (file) => ({ id: file, label: file, source_file: file, file_type: "code" });
const symbolNode = (file, name, line, extra = {}) => ({
  id: `${file}#${name}@${line}`,
  label: `${name}()`,
  source_file: file,
  source_location: `L${line}`,
  symbol_kind: "method",
  ...extra,
});

test("dead-code review defaults to actionable internal code and suppresses public API risk", () => {
  const file = "src/service.js";
  const hidden = symbolNode(file, "hiddenMethod", 2, { member_of: "Service", visibility: "private" });
  const hook = symbolNode(file, "publicHook", 3, { member_of: "Service", visibility: "public" });
  const graph = {
    nodes: [fileNode(file), hidden, hook],
    links: [
      { source: file, target: hidden.id, relation: "contains" },
      { source: file, target: hook.id, relation: "contains" },
    ],
  };
  const sources = new Map([[file, "const match = expression.exec(text);\nclass Service {\n  hiddenMethod() {}\n  publicHook() {}\n}\n"]]);
  const result = computeDeadCodeReview(graph, sources);

  assert.deepEqual(result.candidates.map((candidate) => candidate.symbol), ["hiddenMethod"]);
  assert.equal(result.candidates[0].classification, "internal-method");
  assert.equal(result.candidates[0].confidence, "high");
  assert.equal(result.repoSignals.dynamicLoading, false, "ordinary RegExp.exec is not dynamic code execution");
  assert.equal(result.policy.autoDelete, false);
  assert.equal(result.suppressed.confidence, 2, "public method and public-surface file stay out of the default queue");
  assert.ok(result.warnings.some((warning) => warning.code === "LOW_CONFIDENCE_SUPPRESSED"));

  const expanded = computeDeadCodeReview(graph, sources, { minConfidence: "low" });
  const publicCandidate = expanded.candidates.find((candidate) => candidate.symbol === "publicHook");
  assert.equal(publicCandidate.confidence, "low");
  assert.match(publicCandidate.caveats.join(" "), /downstream packages|reflection/i);
  assert.ok(expanded.candidates.some((candidate) => candidate.kind === "file" && candidate.confidence === "low"));
});

test("dead-code review makes reflection/framework uncertainty explicit", () => {
  const file = "src/controller.java";
  const handler = symbolNode(file, "hiddenHandler", 4, { member_of: "Controller", visibility: "private" });
  const graph = {
    nodes: [fileNode(file), handler],
    links: [{ source: file, target: handler.id, relation: "contains" }],
  };
  const sources = new Map([[file, "@Controller\nclass Controller {\n  void boot(){ Class.forName(name); }\n  private void hiddenHandler() {}\n}\n"]]);
  const result = computeDeadCodeReview(graph, sources, {
    minConfidence: "low",
    entrySet: new Set([file]),
    frameworkEvidence: [{ file, framework: "spring", marker: "@Controller", reason: "Spring invokes controller code externally" }],
  });
  const candidate = result.candidates.find((entry) => entry.symbol === "hiddenHandler");
  assert.equal(candidate.confidence, "low");
  assert.match(candidate.caveats.join(" "), /Spring invokes|Reflection/i);
  assert.equal(result.repoSignals.reflection, true);
  assert.ok(result.warnings.some((warning) => warning.code === "REFLECTION_PRESENT"));
});

test("dead-code review excludes tests and generated/classified paths unless explicitly opted in", () => {
  const testFile = "test-e2e/helpers.js";
  const generatedFile = "src/generated/client.js";
  const benchmarkFile = "benchmarks/bench_common.py";
  const tempFile = "tools/__temp/import_pos.py";
  const testSymbol = symbolNode(testFile, "testHelper", 1, { visibility: "private" });
  const generatedSymbol = symbolNode(generatedFile, "generatedHelper", 2, { visibility: "private" });
  const benchmarkSymbol = symbolNode(benchmarkFile, "benchmarkHelper", 1, { visibility: "private" });
  const tempSymbol = symbolNode(tempFile, "tempHelper", 1, { visibility: "private" });
  const graph = {
    nodes: [fileNode(testFile), fileNode(generatedFile), fileNode(benchmarkFile), fileNode(tempFile), testSymbol, generatedSymbol, benchmarkSymbol, tempSymbol],
    links: [
      { source: testFile, target: testSymbol.id, relation: "contains" },
      { source: generatedFile, target: generatedSymbol.id, relation: "contains" },
      { source: benchmarkFile, target: benchmarkSymbol.id, relation: "contains" },
      { source: tempFile, target: tempSymbol.id, relation: "contains" },
    ],
  };
  const sources = new Map([
    [testFile, "function testHelper() {}"],
    [generatedFile, "// @generated do not edit\nfunction generatedHelper() {}"],
    [benchmarkFile, "def benchmarkHelper(): pass"],
    [tempFile, "def tempHelper(): pass"],
  ]);
  const normal = computeDeadCodeReview(graph, sources);
  assert.equal(normal.candidates.length, 0);
  assert.ok(normal.suppressed.tests > 0);
  assert.ok(normal.suppressed.classified > 0);

  const included = computeDeadCodeReview(graph, sources, { includeTests: true, includeClassified: true });
  assert.ok(included.candidates.some((candidate) => candidate.symbol === "testHelper"));
  assert.ok(included.candidates.some((candidate) => candidate.symbol === "generatedHelper"));
  assert.ok(included.candidates.some((candidate) => candidate.symbol === "benchmarkHelper"));
  assert.ok(included.candidates.some((candidate) => candidate.symbol === "tempHelper"));
});

test("dead-code review never classifies an owned Java field as a method", () => {
  const file = "src/main/java/HealthCheckProducer.java";
  const field = {
    id: `${file}#producerURL@7`,
    label: "producerURL",
    source_file: file,
    source_location: "L7",
    symbol_kind: "field",
    member_of: "HealthCheckProducer",
    visibility: "private",
  };
  const graph = {
    nodes: [fileNode(file), field],
    links: [{ source: file, target: field.id, relation: "contains" }],
  };
  const sources = new Map([[file, "class HealthCheckProducer {\n  private String producerURL;\n}\n"]]);

  const all = computeDeadCodeReview(graph, sources);
  const candidate = all.candidates.find((entry) => entry.symbol === "producerURL");
  assert.equal(candidate.kind, "symbol");
  assert.equal(candidate.classification, "unreferenced-symbol");

  const methodsOnly = computeDeadCodeReview(graph, sources, { kinds: ["method"] });
  assert.equal(methodsOnly.candidates.length, 0);
  assert.ok(methodsOnly.suppressed.kind > 0);
});

test("find_dead_code returns a bounded structured review queue without source bodies", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-dead-tool-"));
  try {
    const file = "src/unused.js";
    const node = symbolNode(file, "unusedHelper", 1, { visibility: "private" });
    const graph = {
      nodes: [fileNode(file), node],
      links: [{ source: file, target: node.id, relation: "contains" }],
      externalImports: [],
    };
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dead-review-fixture" }));
    writeFileSync(join(root, "graph.json"), JSON.stringify(graph));
    // createRepoBoundary resolves this repository-relative path after the directory exists.
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "unused.js"), "function unusedHelper() {}\n");

    const result = tFindDeadCode(null, { top_n: 1 }, { repoRoot: root, graphPath: join(root, "graph.json") });
    assert.equal(result.__weavatrixToolResult, true);
    assert.equal(result.result.verdict, "REVIEW_REQUIRED");
    assert.equal(result.result.policy.autoDelete, false);
    assert.equal(result.result.candidates.length, 1);
    assert.equal(result.page.shown, 1);
    assert.ok(!JSON.stringify(result.result).includes("function unusedHelper"), "structured evidence never includes source bodies");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
