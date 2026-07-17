import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildInternalGraph } from "../src/graph/internal-builder.js";
import { aggregateGraph } from "../src/analysis/graph-analysis.js";

const UPDATE_WIDGET_SOURCE = `const updateWidget = async (id, data, requester) => {
    const context = await getWidgetWithActiveQuery(id, requester)
    if (!context) {
        return {error: \`widget not found for \${id}\`, status: 404}
    }
    const {widget: existingWidget, query: existingQuery} = context
    assertParentQueryWriteAllowed(existingQuery, requester)
    const normalizedData = withLegacyCalculationDefault(
        normalizeWidgetData({
            ...pickWidgetDataWithQuery(existingWidget.getCleanDocument(false, false)),
            ...pickMutableWidgetData(data),
        })
    )
    const {query, validation} = await validateWidgetData(
        normalizedData,
        id,
        existingQuery,
        requester
    )
    const normalizedWidgetData = addWidgetParentStateFields(
        {
            ...normalizedData,
            ownerId: existingWidget.ownerId,
            ownerUsername: existingWidget.ownerUsername,
            ...getEdgeAnalyticsEditorFields(requester),
        },
        query
    )
    const widgetData = addExecutionArtifact(
        normalizedWidgetData,
        query,
        validation,
        existingWidget.executionArtifact
    )

    try {
        const updatedWidget = await updateActiveWidgetDocument(existingWidget, widgetData)
        if (!updatedWidget) {
            return getWidgetWriteConflictResponse(id, requester)
        }
        return formatWidget(updatedWidget, formatQuerySummary(query))
    } catch (error) {
        if (isDuplicateKeyErrorForField(error, 'name')) {
            throw getDuplicateWidgetNameError(normalizedData.name, normalizedData.queryId)
        }
        throw error
    }
}`;

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "rl-complexity-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("source complexity: updateWidget persists exact AST range and source report", async () => {
  const dir = repoWith({ "src/widget.service.js": UPDATE_WIDGET_SOURCE });
  try {
    const graph = await buildInternalGraph(dir);
    const node = graph.nodes.find((item) => String(item.id).includes("#updateWidget@"));
    assert.ok(node, "updateWidget symbol is extracted");
    assert.equal(graph.complexityV, 2);
    assert.equal(node.source_end, `L${UPDATE_WIDGET_SOURCE.split("\n").length}`);

    const report = node.complexity;
    assert.equal(report.params, 3);
    assert.equal(report.branches, 4);
    assert.equal(report.cyclomatic, 5);
    assert.equal(report.loops, 0);
    assert.equal(report.returns, 3);
    assert.equal(report.awaits, 3);
    assert.equal(report.callCount, 17);
    assert.equal(report.objectLiterals, 3);
    assert.equal(report.spreadCopies, 4);
    assert.match(report.timeLabel, /O\(n\)/);
    assert.match(report.timeLabel, /I\/O|callee/i);
    assert.match(report.memoryLabel, /O\(n\)/);

    const analysis = aggregateGraph(graph, dir);
    const persisted = analysis.modules[0].files[0].symbols.find((item) => item.id === node.id);
    assert.equal(analysis.complexityV, 2);
    assert.equal(persisted.loc, UPDATE_WIDGET_SOURCE.split("\n").length);
    assert.equal(persisted.endLine, UPDATE_WIDGET_SOURCE.split("\n").length);
    assert.deepEqual(persisted.complexity, report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source complexity: nested declaration keeps exact outer range without inheriting inner work", async () => {
  const source = [
    "function outer(items) {",
    "  const marker = { ok: true }",
    "  function inner(rows) {",
    "    return rows.map((row) => ({ ...row }))",
    "  }",
    "  return marker.ok ? items : []",
    "}",
  ].join("\n");
  const dir = repoWith({ "src/nested.js": source });
  try {
    const graph = await buildInternalGraph(dir);
    const symbol = (name) => graph.nodes.find((item) => String(item.id).includes(`#${name}@`));
    const outer = symbol("outer");
    const inner = symbol("inner");
    assert.equal(outer.source_end, "L7");
    assert.equal(inner.source_end, "L5");
    assert.equal(outer.complexity.loops, 0, "nested function body is not charged to its parent");
    assert.equal(inner.complexity.loops, 1);
    assert.match(inner.complexity.timeLabel, /O\(n\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source complexity: language adapters share loop, sort, spread, and recursion semantics", async () => {
  const dir = repoWith({
    "src/shape.py": "def transform(self, items):\n    return [{**item} for item in sorted(items)]\n",
    "src/pair.go": "package shape\nfunc Pair(items []int) {\n for _, a := range items {\n  for _, b := range items { println(a, b) }\n }\n}\n",
    "src/Shape.java": "class Shape { void process(java.util.List<String> xs) { for (String x : xs) { xs.sort(null); } } }\n",
    "src/stable.js": "function stable(value) { if (value == null) return value; return Object.keys(value).sort().map((key) => stable(value[key])); }\n",
  });
  try {
    const graph = await buildInternalGraph(dir);
    const report = (name) => graph.nodes.find((item) => String(item.id).includes(`#${name}@`))?.complexity;
    const python = report("transform");
    assert.equal(python.params, 1, "Python self is not an input parameter");
    assert.equal(python.loops, 1);
    assert.equal(python.sorts, 1);
    assert.equal(python.spreadCopies, 1);
    assert.match(python.timeLabel, /O\(n log n\)/);

    const go = report("Pair");
    assert.equal(go.maxLoopDepth, 2);
    assert.match(go.timeLabel, /O\(n\^2\)/);

    const java = report("process");
    assert.equal(java.loops, 1);
    assert.equal(java.sorts, 1);
    assert.match(java.timeLabel, /sort inside iteration/);

    const js = report("stable");
    assert.equal(js.recursion, true);
    assert.equal(js.sorts, 1);
    assert.equal(js.loops, 1);
    assert.match(js.timeLabel, /recursive/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source complexity: sequential iterator chains stay linear while callback nesting multiplies", async () => {
  const dir = repoWith({
    "src/iterators.js": [
      "function sequential(items) { return items.map((x) => x + 1).filter((x) => x > 1) }",
      "function nested(groups) { return groups.map((rows) => rows.map((row) => row.id)) }",
      "function prose() { const text = 'for while .map('; return /for|while/.test(text) }",
    ].join("\n")
  });
  try {
    const graph = await buildInternalGraph(dir);
    const report = (name) => graph.nodes.find((item) => String(item.id).includes(`#${name}@`))?.complexity;
    assert.equal(report("sequential").loops, 2);
    assert.equal(report("sequential").maxLoopDepth, 1);
    assert.match(report("sequential").timeLabel, /O\(n\)/);
    assert.equal(report("nested").loops, 2);
    assert.equal(report("nested").maxLoopDepth, 2);
    assert.match(report("nested").timeLabel, /O\(n\^2\)/);
    assert.equal(report("prose").loops, 0, "strings and regex literals are syntax nodes, not loop text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
