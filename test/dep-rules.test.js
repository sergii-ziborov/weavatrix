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
  assert.equal(cyc[0].cycleRoute, "src/a.js → src/b.js → src/c.js → src/a.js");
  assert.match(cyc[0].detail, /^src\/a\.js → src\/b\.js → src\/c\.js → src\/a\.js/);
  assert.match(cyc[0].detail, /→/);
});

test("dep-rules: huge representative routes stay closed and bounded", () => {
  const files = Array.from({ length: 80 }, (_, index) => `src/n${String(index).padStart(2, "0")}.js`);
  const graph = {
    nodes: files.map(fileNode),
    links: files.map((file, index) => imp(file, files[(index + 1) % files.length])),
  };
  const finding = computeStructureFindings(graph).findings.find((item) => item.rule === "circular-dep");
  assert.match(finding.cycleRoute, /^src\/n00\.js → src\/n01\.js/);
  assert.match(finding.cycleRoute, /file\(s\) omitted/);
  assert.match(finding.cycleRoute, /→ src\/n00\.js$/);
  assert.ok(finding.detail.length < 1_000, `cycle detail must stay bounded (got ${finding.detail.length})`);
});

test("dep-rules: a 34-file cycle keeps the complete closed route", () => {
  const files = Array.from({ length: 34 }, (_, index) => `src/c${String(index).padStart(2, "0")}.js`);
  const graph = {
    nodes: files.map(fileNode),
    links: files.map((file, index) => imp(file, files[(index + 1) % files.length])),
  };
  const finding = computeStructureFindings(graph).findings.find((item) => item.rule === "circular-dep");
  const route = finding.cycleRoute.split(" \u2192 ");
  assert.equal(route.length, 35);
  assert.equal(route[0], route.at(-1));
  assert.doesNotMatch(finding.cycleRoute, /omitted/);
});

test("dep-rules: representative cycle is deterministic when an SCC branches", () => {
  const leftFirst = new Map([
    ["a.js", new Set(["b.js", "c.js"])],
    ["b.js", new Set(["a.js"])],
    ["c.js", new Set(["a.js"])],
  ]);
  const rightFirst = new Map([
    ["a.js", new Set(["c.js", "b.js"])],
    ["c.js", new Set(["a.js"])],
    ["b.js", new Set(["a.js"])],
  ]);
  assert.deepEqual(representativeCycle(leftFirst, ["a.js", "b.js", "c.js"]), ["a.js", "b.js", "a.js"]);
  assert.deepEqual(representativeCycle(rightFirst, ["c.js", "a.js", "b.js"]), ["a.js", "b.js", "a.js"]);
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

test("dep-rules: type-only edges create info coupling, not a runtime cycle or boundary violation", () => {
  const typeImp = (a, b) => ({ ...imp(a, b), typeOnly: true, specifier: "./types" });
  const graph = {
    nodes: ["main/a.ts", "shared/b.ts", "shared/c.ts"].map(fileNode),
    links: [imp("main/a.ts", "shared/b.ts"), typeImp("shared/b.ts", "shared/c.ts"), imp("shared/c.ts", "main/a.ts")],
  };
  const runtime = buildFileImportGraph(graph);
  const inclusive = buildFileImportGraph(graph, { includeTypeOnly: true });
  assert.equal(findSccs(runtime.adj).length, 0, "runtime graph is acyclic");
  assert.equal(findSccs(inclusive.adj).length, 1, "type-inclusive graph preserves design coupling");
  const r = computeStructureFindings(graph, {
    rules: { forbidden: [{ name: "runtime-only", from: "shared/b.ts", to: "shared/c.ts", severity: "high" }] },
  });
  assert.equal(r.stats.runtimeCycles, 0);
  assert.equal(r.stats.typeCouplings, 1);
  assert.equal(r.stats.runtimeImportEdges, 2);
  assert.equal(r.stats.typeOnlyImportEdges, 1);
  assert.equal(r.stats.boundaryViolations, 0);
  const coupling = r.findings.find((f) => f.rule === "type-coupling");
  assert.equal(coupling.severity, "info");
  assert.match(coupling.title, /no runtime cycle/i);
});

test("dep-rules: Rust compile-only edges create compile-time coupling, not runtime cycles or boundaries", () => {
  // Cross-directory .rs cycle — no module-tree anchor, so it stays a reported coupling.
  const rustImp = (a, b) => ({ ...imp(a, b), compileOnly: true, specifier: "crate::module" });
  const graph = {
    nodes: ["crate/src/api/handlers.rs", "crate/src/model/user.rs", "crate/src/service/sync.rs"].map(fileNode),
    links: [
      rustImp("crate/src/api/handlers.rs", "crate/src/model/user.rs"),
      rustImp("crate/src/model/user.rs", "crate/src/service/sync.rs"),
      rustImp("crate/src/service/sync.rs", "crate/src/api/handlers.rs"),
    ],
  };
  const runtime = buildFileImportGraph(graph);
  const inclusive = buildFileImportGraph(graph, { includeCompileOnly: true });
  assert.equal(findSccs(runtime.adj).length, 0);
  assert.equal(findSccs(inclusive.adj).length, 1);
  const result = computeStructureFindings(graph, {
    rules: { forbidden: [{ name: "runtime-only", from: "crate/src/**", to: "crate/src/**", severity: "high" }] },
  });
  assert.equal(result.stats.runtimeCycles, 0);
  assert.equal(result.stats.compileTimeCouplings, 1);
  assert.equal(result.stats.rustModuleTreeCouplings, 0);
  assert.equal(result.stats.runtimeImportEdges, 0);
  assert.equal(result.stats.compileOnlyImportEdges, 3);
  assert.equal(result.stats.boundaryViolations, 0);
  const coupling = result.findings.find((finding) => finding.rule === "compile-time-coupling");
  assert.equal(coupling.severity, "info");
  assert.match(coupling.title, /no runtime cycle/i);
  assert.equal(result.findings.some((finding) => finding.rule === "circular-dep"), false);
});

test("dep-rules: idiomatic Rust module-tree cycles are counted, not reported as couplings", () => {
  const rustImp = (a, b) => ({ ...imp(a, b), compileOnly: true, specifier: "crate::module" });
  const cycleGraph = (files) => ({
    nodes: files.map(fileNode),
    links: files.map((file, index) => rustImp(file, files[(index + 1) % files.length])),
  });
  const suppressed = [
    ["src/util/mod.rs", "src/util/tables.rs"], // mod.rs parent <-> child (super::)
    ["crate/src/lib.rs", "crate/src/api.rs", "crate/src/model.rs"], // lib.rs-anchored crate root
    ["src/foo.rs", "src/foo/bar.rs"], // 2018-edition parent file <-> child module
  ];
  for (const files of suppressed) {
    const result = computeStructureFindings(cycleGraph(files));
    assert.equal(result.stats.compileTimeCouplings, 0, files.join(" <-> "));
    assert.equal(result.stats.rustModuleTreeCouplings, 1, files.join(" <-> "));
    assert.equal(result.findings.some((finding) => finding.rule === "compile-time-coupling"), false, files.join(" <-> "));
    assert.equal(result.findings.some((finding) => finding.rule === "circular-dep"), false, files.join(" <-> "));
  }
  // Genuine cross-directory pair keeps its finding — neither member anchors the other's directory.
  const cross = computeStructureFindings(cycleGraph(["src/a/x.rs", "src/b/y.rs"]));
  assert.equal(cross.stats.compileTimeCouplings, 1);
  assert.equal(cross.stats.rustModuleTreeCouplings, 0);
  assert.equal(cross.findings.filter((finding) => finding.rule === "compile-time-coupling").length, 1);
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
