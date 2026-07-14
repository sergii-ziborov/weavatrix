// dep-rules — cycles (Tarjan), orphans, and the glob boundary DSL over hand-built graphs (P2 of
// DEPS_SECURITY_PLAN.md). Pure inputs, no filesystem.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileImportGraph, findSccs, representativeCycle, globToRe, checkBoundaries, computeStructureFindings } from "../src/analysis/dep-rules.js";

const fileNode = (f) => ({ id: f, label: f.split("/").pop(), source_file: f });
const imp = (a, b) => ({ source: a, target: b, relation: "imports", confidence: "EXTRACTED" });

test("dep-rules: 3-node cycle detected with a readable representative path", () => {
  const graph = {
    nodes: ["src/a.js", "src/b.js", "src/c.js", "src/free.js"].map(fileNode),
    links: [imp("src/a.js", "src/b.js"), imp("src/b.js", "src/c.js"), imp("src/c.js", "src/a.js"), imp("src/free.js", "src/a.js")],
  };
  const { adj } = buildFileImportGraph(graph);
  const sccs = findSccs(adj);
  assert.equal(sccs.length, 1);
  assert.equal(sccs[0].length, 3);
  const cycle = representativeCycle(adj, sccs[0]);
  assert.equal(cycle[0], cycle[cycle.length - 1]); // closes on itself
  assert.equal(new Set(cycle).size, 3);
  const r = computeStructureFindings(graph);
  const cyc = r.findings.filter((f) => f.rule === "circular-dep");
  assert.equal(cyc.length, 1);
  assert.equal(cyc[0].severity, "medium");
  assert.match(cyc[0].detail, /→/);
});

test("dep-rules: two independent cycles → two findings; acyclic graph → none", () => {
  const cyclic = {
    nodes: ["a.js", "b.js", "x.js", "y.js"].map(fileNode),
    links: [imp("a.js", "b.js"), imp("b.js", "a.js"), imp("x.js", "y.js"), imp("y.js", "x.js")],
  };
  assert.equal(computeStructureFindings(cyclic).stats.cycles, 2);
  const acyclic = { nodes: ["a.js", "b.js"].map(fileNode), links: [imp("a.js", "b.js")] };
  assert.equal(computeStructureFindings(acyclic).stats.cycles, 0);
});

test("dep-rules: Go same-directory edges are excluded from the cycle graph", () => {
  const graph = {
    nodes: ["pkg/a.go", "pkg/b.go"].map(fileNode),
    links: [imp("pkg/a.go", "pkg/b.go"), imp("pkg/b.go", "pkg/a.go")],
  };
  assert.equal(computeStructureFindings(graph).stats.cycles, 0);
});

test("dep-rules: orphans flagged; entries/tests/data exempt; npm-importing scripts drop confidence", () => {
  const graph = {
    nodes: ["src/island.js", "src/tool.js", "src/index.js", "test/x.test.js", "config.json", "src/used.js"].map(fileNode),
    links: [imp("src/index.js", "src/used.js")],
  };
  const r = computeStructureFindings(graph, { externalImportFiles: new Set(["src/tool.js"]) });
  const orphans = r.findings.filter((f) => f.rule === "orphan-file");
  assert.deepEqual(orphans.map((f) => f.file).sort(), ["src/island.js", "src/tool.js"]);
  assert.equal(orphans.find((f) => f.file === "src/tool.js").confidence, "low");
  assert.equal(orphans.find((f) => f.file === "src/island.js").confidence, "medium");
});

test("dep-rules: forbidden and allowedOnly boundary rules fire on matching edges only", () => {
  const edges = [["main/a.js", "renderer/b.js"], ["main/a.js", "main/c.js"], ["ui/x.js", "core/y.js"], ["ui/x.js", "ui/z.js"]];
  const rules = {
    forbidden: [{ name: "no-renderer-in-main", from: "main/**", to: "renderer/**", severity: "high" }],
    allowedOnly: [{ name: "ui-layering", from: "ui/**", to: ["ui/**", "shared/**"] }],
  };
  const v = checkBoundaries(edges, rules);
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.name).sort(), ["no-renderer-in-main", "ui-layering"]);
  assert.equal(v.find((x) => x.name === "ui-layering").to, "core/y.js");
});

test("dep-rules: globToRe covers ** across segments and * within a segment", () => {
  assert.ok(globToRe("main/**").test("main/deep/x.js"));
  assert.ok(!globToRe("main/**").test("renderer/x.js"));
  assert.ok(globToRe("**/x.js").test("x.js"));
  assert.ok(globToRe("a/**/b.js").test("a/b.js"));
  assert.ok(!globToRe("src/*.js").test("src/deep/a.js"));
});
