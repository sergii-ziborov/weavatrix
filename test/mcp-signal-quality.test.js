import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGraph, diffGraphs, formatGraphDiff } from "../src/mcp/graph-context.mjs";
import { tGodNodes } from "../src/mcp/tools-graph.mjs";
import { tGetDependents } from "../src/mcp/tools-impact.mjs";
import { tModuleMap } from "../src/mcp/tools-health.mjs";
import { aggregateGraph } from "../src/analysis/graph-analysis.js";

function graphFile(graph) {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-signal-"));
  const path = join(dir, "graph.json");
  writeFileSync(path, JSON.stringify(graph));
  return { dir, path, graph: loadGraph(path) };
}

test("god_nodes ranks unique runtime neighbors and does not double-count bidirectional links", () => {
  const nodes = ["A", "B", "C", "D", "TypeHub", "T1", "T2", "T3"].map((id) => ({ id, label: id }));
  const links = [
    { source: "A", target: "B", relation: "calls" },
    { source: "A", target: "B", relation: "calls" },
    { source: "B", target: "A", relation: "calls" },
    { source: "A", target: "C", relation: "imports", typeOnly: true },
    { source: "D", target: "A", relation: "imports", typeOnly: true },
    { source: "TypeHub", target: "T1", relation: "imports", typeOnly: true },
    { source: "TypeHub", target: "T2", relation: "imports", typeOnly: true },
    { source: "TypeHub", target: "T3", relation: "imports", typeOnly: true },
  ];
  const fx = graphFile({ nodes, links, edgeTypesV: 1 });
  try {
    const output = tGodNodes(fx.graph, { top_n: 8 });
    const rows = output.split("\n").filter((line) => /^\s*\d+\./.test(line));
    assert.match(rows[0], / A\s+\(3 unique: 1 runtime, 2 compile-only; out 2, in 2; 5 edge occurrences\)/);
    assert.ok(rows.findIndex((line) => / A\s+/.test(line)) < rows.findIndex((line) => / TypeHub\s+/.test(line)), "runtime hub ranks before a larger type-only hub");
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("god_nodes preserves repeated-call complexity as a secondary lens", () => {
  const nodes = ["Broad", "B1", "B2", "B3", "Repeated", "Helper"].map((id) => ({ id, label: id }));
  const links = [
    { source: "Broad", target: "B1", relation: "calls" },
    { source: "Broad", target: "B2", relation: "calls" },
    { source: "Broad", target: "B3", relation: "calls" },
    ...Array.from({ length: 24 }, () => ({ source: "Repeated", target: "Helper", relation: "calls" })),
  ];
  const fx = graphFile({ nodes, links, edgeTypesV: 1 });
  try {
    const output = tGodNodes(fx.graph, { top_n: 1 });
    assert.match(output.split("\n")[1], /Broad/, "unique-neighbor coupling stays the primary rank");
    assert.match(output, /High occurrence hotspots[\s\S]*Repeated  \(24 occurrences across 1 unique neighbors; 23 repeats\)/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("get_dependents keeps a real runtime path even when a shorter type-only path exists", () => {
  const fx = graphFile({
    edgeTypesV: 1,
    nodes: ["A", "R", "T"].map((id) => ({ id, label: id })),
    links: [
      { source: "A", target: "T", relation: "imports", typeOnly: true },
      { source: "A", target: "R", relation: "imports" },
      { source: "R", target: "T", relation: "imports" },
    ],
  });
  try {
    const output = tGetDependents(fx.graph, { label: "T", depth: 2 });
    assert.match(output, /\[d2 runtime \+ compile-time\(d1\)\].* A /);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("graph_diff calls an SCC shrink a membership change, not a newly introduced cycle", () => {
  const nodes = ["A", "B", "T"].map((id) => ({ id }));
  const oldGraph = {
    edgeTypesV: 1, nodes,
    links: [
      { source: "A", target: "B", relation: "imports" },
      { source: "B", target: "T", relation: "imports" },
      { source: "T", target: "A", relation: "imports" },
    ],
  };
  const newGraph = {
    edgeTypesV: 1, nodes,
    links: [
      { source: "A", target: "B", relation: "imports" },
      { source: "B", target: "A", relation: "imports" },
    ],
  };
  const delta = diffGraphs(oldGraph, newGraph);
  assert.equal(delta.cycles.runtime.introduced.length, 0);
  assert.equal(delta.cycles.runtime.membershipChanged, 1);
  const output = formatGraphDiff(delta);
  assert.match(output, /SCC membership change/);
  assert.doesNotMatch(output, /genuinely new runtime SCC/);
});

test("graph_diff establishes a typed baseline instead of comparing legacy runtime classifications", () => {
  const nodes = [{ id: "A" }, { id: "B" }];
  const oldGraph = { edgeTypesV: 0, nodes, links: [{ source: "A", target: "B", relation: "imports" }] };
  const newGraph = { edgeTypesV: 1, nodes, links: [{ source: "A", target: "B", relation: "imports", typeOnly: true }] };
  const delta = diffGraphs(oldGraph, newGraph);
  assert.equal(delta.edges.added, 0);
  assert.equal(delta.edges.removed, 0);
  assert.equal(delta.cycles.runtime, null);
  assert.match(formatGraphDiff(delta), /typed baseline established/);
});

test("module aggregation and module_map separate runtime from type-only dependencies", () => {
  const graph = {
    edgeTypesV: 1,
    nodes: [
      { id: "renderer/global.d.ts", source_file: "renderer/global.d.ts", file_type: "code" },
      { id: "main/preload.ts", source_file: "main/preload.ts", file_type: "code" },
      { id: "main/a.ts", source_file: "main/a.ts", file_type: "code" },
      { id: "shared/b.ts", source_file: "shared/b.ts", file_type: "code" },
    ],
    links: [
      { source: "renderer/global.d.ts", target: "main/preload.ts", relation: "imports", typeOnly: true },
      { source: "main/a.ts", target: "shared/b.ts", relation: "imports" },
    ],
  };
  const aggregate = aggregateGraph(graph, null);
  assert.deepEqual(aggregate.moduleEdges, [{ from: "main", to: "shared", count: 1 }]);
  assert.deepEqual(aggregate.typeOnlyModuleEdges, [{ from: "renderer", to: "main", count: 1 }]);

  const fx = graphFile(graph);
  try {
    const output = tModuleMap(fx.graph, { top_n: 10 }, { graphPath: fx.path });
    assert.match(output, /Strongest runtime module dependencies:[\s\S]*main → shared/);
    assert.match(output, /Type-only module dependencies[\s\S]*renderer → main/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
