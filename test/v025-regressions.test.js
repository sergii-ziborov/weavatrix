import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {loadGraph} from "../src/mcp/graph-context.mjs";
import {tGetDependents} from "../src/mcp/tools-impact.mjs";
import {tFindDeadCode, tFindDuplicates} from "../src/mcp/tools-health.mjs";
import {tInspectSymbol} from "../src/mcp/tools-source.mjs";
import {computeDuplicates} from "../src/analysis/duplicates.js";
import {computeDeadCodeReview} from "../src/analysis/dead-code-review.js";
import {buildInternalGraph} from "../src/graph/internal-builder.js";
import {querySymbolPrecision, readCachedSymbolPrecisionEvidence} from "../src/precision/symbol-query.js";

function withGraph(graph) {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-v025-"));
  const graphPath = join(root, "graph.json");
  writeFileSync(graphPath, JSON.stringify(graph));
  return {root, graphPath, graph: loadGraph(graphPath)};
}

test("get_dependents keeps symbol impact precise unless module importers are requested", () => {
  const target = {id: "src/service.js#helper@1", label: "helper()", source_file: "src/service.js"};
  const caller = {id: "src/caller.js#run@1", label: "run()", source_file: "src/caller.js"};
  const fixture = withGraph({
    nodes: [
      {id: "src/service.js", label: "service.js", source_file: "src/service.js"},
      {id: "src/unrelated.js", label: "unrelated.js", source_file: "src/unrelated.js"},
      target,
      caller,
    ],
    links: [
      {source: "src/service.js", target: target.id, relation: "contains"},
      {source: caller.id, target: target.id, relation: "calls"},
      {source: "src/unrelated.js", target: "src/service.js", relation: "imports"},
    ],
  });
  try {
    const precise = tGetDependents(fixture.graph, {label: target.id, depth: 1});
    assert.match(precise, /run\(\)/);
    assert.doesNotMatch(precise, /unrelated\.js/);
    const conservative = tGetDependents(fixture.graph, {label: target.id, depth: 1, include_container_importers: true});
    assert.match(conservative, /unrelated\.js/);
    assert.match(conservative, /explicit request/);
  } finally { rmSync(fixture.root, {recursive: true, force: true}); }
});

test("inspect_symbol caps dense graph occurrence output", async () => {
  const target = {id: "src/target.ts#target@1", label: "target()", source_file: "src/target.ts", source_location: "L1", symbol_kind: "function"};
  const callers = Array.from({length: 150}, (_, index) => ({id: `src/c${index}.ts#call@1`, label: `call${index}()`, source_file: `src/c${index}.ts`, source_location: "L1"}));
  const fixture = withGraph({
    nodes: [{id: "src/target.ts", label: "target.ts", source_file: "src/target.ts"}, target, ...callers],
    links: [
      {source: "src/target.ts", target: target.id, relation: "contains"},
      ...callers.map((caller) => ({source: caller.id, target: target.id, relation: "calls", line: 1})),
    ],
  });
  try {
    const result = await tInspectSymbol(fixture.graph, {label: target.id, precision: "graph"}, {repoRoot: fixture.root, graphPath: fixture.graphPath});
    assert.equal(result.result.graph.occurrenceTotal, 150);
    assert.equal(result.result.graph.occurrences.length, 100);
    assert.equal(result.result.graph.occurrencesCapped, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.result), "utf8") < 64 * 1024);
  } finally { rmSync(fixture.root, {recursive: true, force: true}); }
});

test("duplicate scan can inspect high-confidence fragments below 30 tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-v025-small-dup-"));
  const small = `function clampValue(value) {
  return value > 9 ? 9 : value;
}`;
  const nodes = [];
  for (const file of ["src/a.js", "src/b.js"]) {
    const path = join(root, file);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${small}\n`);
    nodes.push({id: file, label: file, source_file: file, file_type: "code"});
    nodes.push({id: `${file}#clampValue@1`, label: "clampValue()", source_file: file, source_location: "L1"});
  }
  const graphPath = join(root, "graph.json");
  writeFileSync(graphPath, JSON.stringify({nodes, links: []}));
  try {
    const normal = computeDuplicates(root, graphPath);
    assert.equal(normal.frags.length, 0, "normal compute floor stays at 30 tokens");
    const result = computeDuplicates(root, graphPath, {minTokens: 12});
    assert.equal(result.frags.length, 2);
    assert.ok(result.frags.every((fragment) => fragment.n < 30));
    assert.ok(result.modes.strict.some((pair) => pair[2] === 100));
    assert.match(tFindDuplicates(null, {mode: "strict", min_tokens: 12, min_similarity: 95}, {repoRoot: root, graphPath}), /Found 1 clone group/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("dead-code review surfaces production symbols consumed only by tests", () => {
  const production = "src/legacy-helper.js";
  const testFile = "test/legacy-helper.test.js";
  const helper = {id: `${production}#legacyHelper@1`, label: "legacyHelper()", source_file: production, source_location: "L1", symbol_kind: "function", visibility: "private"};
  const testCaller = {id: `${testFile}#exerciseLegacy@1`, label: "exerciseLegacy()", source_file: testFile, source_location: "L1", symbol_kind: "function", visibility: "private"};
  const graph = {
    nodes: [
      {id: production, label: production, source_file: production, file_type: "code"},
      {id: testFile, label: testFile, source_file: testFile, file_type: "code"},
      helper,
      testCaller,
    ],
    links: [
      {source: production, target: helper.id, relation: "contains"},
      {source: testFile, target: testCaller.id, relation: "contains"},
      {source: testCaller.id, target: helper.id, relation: "calls"},
    ],
  };
  const sources = new Map([
    [production, "function legacyHelper() { return 1; }\n"],
    [testFile, "function exerciseLegacy() { return legacyHelper(); }\n"],
  ]);
  const result = computeDeadCodeReview(graph, sources);
  const candidate = result.candidates.find((entry) => entry.symbol === "legacyHelper");
  assert.ok(candidate);
  assert.equal(candidate.classification, "test-only-function");
  assert.equal(candidate.confidence, "medium");
  assert.match(candidate.reason, /only from test\/e2e/);
  assert.match(candidate.evidence[0].fact, /test\/legacy-helper\.test\.js/);
  assert.equal(result.totals.rawTestOnlySymbols, 1);
});

test("on-demand symbol precision queries only the requested declaration and uses its separate cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-v025-symbol-precision-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({compilerOptions: {strict: true, noEmit: true}, include: ["src/**/*.ts"]}));
  writeFileSync(join(root, "src", "target.ts"), "export function target(): number { return 1; }\n");
  const callerSource = "import { target } from './target';\nexport function caller(): number { return target(); }\n";
  writeFileSync(join(root, "src", "caller.ts"), callerSource);
  try {
    const graph = {...await buildInternalGraph(root), graphBuildMode: "full", graphBuildScope: "", graphPrecisionMode: "off"};
    const graphPath = join(root, "graph.json");
    writeFileSync(graphPath, JSON.stringify(graph));
    const target = graph.nodes.find((node) => node.source_file === "src/target.ts" && node.label === "target()");
    const graphOnly = await tInspectSymbol(loadGraph(graphPath), {
      label: target.id,
      precision: "graph",
      context_lines: 1,
    }, {repoRoot: root, graphPath});
    assert.equal(graphOnly.result.status, "OK");
    assert.equal(graphOnly.result.definition.id, target.id);
    assert.ok(graphOnly.result.graph.occurrences.some((occurrence) => occurrence.label === "caller()"));
    assert.match(graphOnly.result.source.definition.text, /function target/);
    let references = 0;
    const clientFactory = async () => ({
      provider: "fake-point-lsp",
      version: "1.0.0",
      async openDocument() {},
      async references() {
        references++;
        const character = callerSource.split("\n")[1].lastIndexOf("target");
        return [{uri: pathToFileURL(join(root, "src", "caller.ts")).href, range: {start: {line: 1, character}, end: {line: 1, character: character + 6}}}];
      },
      async close() {},
    });
    const first = await querySymbolPrecision({repoRoot: root, graphPath, targetId: target.id, clientFactory});
    assert.equal(first.cached, false);
    assert.equal(first.overlay.state, "COMPLETE");
    assert.equal(first.overlay.coverage.selected, 1);
    assert.equal(first.overlay.locations.length, 1);
    assert.equal(first.overlay.locations[0].source.includes("#caller@"), true);
    const evidence = readCachedSymbolPrecisionEvidence({repoRoot: root, graphPath, graph});
    assert.deepEqual(evidence.referenceSymbols, [target.id]);
    assert.deepEqual(evidence.productionReferenceSymbols, [target.id]);
    assert.deepEqual(evidence.testReferenceSymbols, []);
    assert.deepEqual(evidence.noReferenceSymbols, []);
    const deadReview = tFindDeadCode(loadGraph(graphPath, {repoRoot: root}), {}, {repoRoot: root, graphPath});
    assert.ok(!deadReview.result.candidates.some((candidate) => candidate.id === target.id), "an exact point-query caller removes the symbol from find_dead_code");
    const second = await querySymbolPrecision({repoRoot: root, graphPath, targetId: target.id, clientFactory});
    assert.equal(second.cached, true);
    assert.equal(references, 1);
    assert.equal(existsSync(join(root, "precision-symbols.json")), true);
    assert.equal(existsSync(join(root, "precision.json")), false, "point queries never overwrite the broad overlay");
  } finally { rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 100}); }
});
