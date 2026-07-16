import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGraph, diffGraphs, formatGraphDiff, findSeeds } from "../src/mcp/graph-context.mjs";
import { tGodNodes, tQueryGraph } from "../src/mcp/tools-graph.mjs";
import { tGetDependents } from "../src/mcp/tools-impact.mjs";
import { tModuleMap, formatAuditFinding } from "../src/mcp/tools-health.mjs";
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
  const fx = graphFile({ nodes, links, edgeTypesV: 2 });
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
  const fx = graphFile({ nodes, links, edgeTypesV: 2 });
  try {
    const output = tGodNodes(fx.graph, { top_n: 1 });
    assert.match(output.split("\n")[1], /Broad/, "unique-neighbor coupling stays the primary rank");
    assert.match(output, /High occurrence hotspots[\s\S]*Repeated  \(24 occurrences across 1 unique neighbors; 23 repeats\)/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("god_nodes suppresses classified build/generated hubs unless explicitly requested", () => {
  const generated = { id: "build/static/js/main.js#e@1", label: "e()", source_file: "build/static/js/main.js" };
  const product = { id: "src/service.ts#serve@1", label: "serve()", source_file: "src/service.ts" };
  const neighbors = Array.from({ length: 6 }, (_, index) => ({ id: `src/n${index}.ts`, label: `n${index}.ts`, source_file: `src/n${index}.ts` }));
  const fx = graphFile({
    nodes: [generated, product, ...neighbors],
    links: [
      ...neighbors.map((neighbor) => ({ source: generated.id, target: neighbor.id, relation: "calls" })),
      { source: product.id, target: neighbors[0].id, relation: "calls" },
      { source: product.id, target: neighbors[1].id, relation: "calls" },
    ],
  });
  try {
    const production = tGodNodes(fx.graph, { top_n: 1 }, { repoRoot: fx.dir });
    assert.match(production.split("\n")[1], /serve\(\)/, "tracked build output cannot displace a product hub");
    assert.doesNotMatch(production, /build\/static\/js/);
    assert.match(production, /classified as tests\/e2e\/generated\/build output/);

    const all = tGodNodes(fx.graph, { top_n: 1, include_classified: true }, { repoRoot: fx.dir });
    assert.match(all.split("\n")[1], /e\(\)/, "classified hubs remain available through an explicit opt-in");
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph keeps one strong seed per architecture intent", () => {
  const core = [
    { id: "src/main.tsx", label: "main.tsx", source_file: "src/main.tsx" },
    { id: "src/app/AuthGate.tsx", label: "AuthGate.tsx", source_file: "src/app/AuthGate.tsx" },
    { id: "src/router/index.ts", label: "index.ts", source_file: "src/router/index.ts" },
    { id: "src/layout/AppLayout.tsx", label: "AppLayout.tsx", source_file: "src/layout/AppLayout.tsx" },
    { id: "src/api/index.ts", label: "index.ts", source_file: "src/api/index.ts" },
    { id: "src/store/index.ts", label: "index.ts", source_file: "src/store/index.ts" },
  ];
  const noise = { id: "src/dashboard/actions.ts#validateApiState@9", label: "validateApiState()", source_file: "src/dashboard/actions.ts" };
  const helpers = Array.from({ length: 12 }, (_, index) => ({ id: `src/dashboard/helper-${index}.ts`, label: `helper-${index}.ts` }));
  const fx = graphFile({
    nodes: [...core, noise, ...helpers],
    links: helpers.map((helper) => ({ source: noise.id, target: helper.id, relation: "calls" })),
  });
  try {
    const seeds = findSeeds(fx.graph, "bootstrap authentication routing layout api state", 6);
    assert.deepEqual(new Set(seeds.map((node) => node.id)), new Set(core.map((node) => node.id)));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph exact seed_files disable fuzzy architecture seeds unless augmentation is explicit", () => {
  const pinned = { id: "src/main.tsx", label: "main.tsx", source_file: "src/main.tsx" };
  const fuzzy = { id: "src/auth/AuthGate.tsx", label: "AuthGate.tsx", source_file: "src/auth/AuthGate.tsx" };
  const fx = graphFile({nodes: [pinned, fuzzy], links: []});
  try {
    const strict = tQueryGraph(fx.graph, {question: "authentication", seed_files: ["src/main.tsx"], depth: 1});
    assert.match(strict, /Seeds: main\.tsx/);
    assert.doesNotMatch(strict, /Seeds:.*AuthGate/);
    const augmented = tQueryGraph(fx.graph, {question: "authentication", seed_files: ["src/main.tsx"], augment_seeds: true, depth: 1});
    assert.match(augmented, /Seeds:.*AuthGate/);
  } finally { rmSync(fx.dir, {recursive: true, force: true}); }
});

test("barrel proxy hops do not inflate semantic hubs, modules, or dependents", () => {
  const graph = {
    barrelResolutionV: 1,
    nodes: [
      { id: "src/app/App.tsx", label: "App.tsx", source_file: "src/app/App.tsx", file_type: "code" },
      { id: "src/page/Page.tsx", label: "Page.tsx", source_file: "src/page/Page.tsx", file_type: "code" },
      { id: "src/shared/components/index.ts", label: "index.ts", source_file: "src/shared/components/index.ts", file_type: "code" },
      { id: "src/ui/Button.tsx", label: "Button.tsx", source_file: "src/ui/Button.tsx", file_type: "code" },
    ],
    links: [
      { source: "src/app/App.tsx", target: "src/shared/components/index.ts", relation: "imports", barrelProxy: true },
      { source: "src/page/Page.tsx", target: "src/shared/components/index.ts", relation: "imports", barrelProxy: true },
      { source: "src/shared/components/index.ts", target: "src/ui/Button.tsx", relation: "re_exports", barrelProxy: true },
      { source: "src/app/App.tsx", target: "src/ui/Button.tsx", relation: "imports", semanticOrigin: true, viaBarrel: "src/shared/components/index.ts" },
      { source: "src/page/Page.tsx", target: "src/ui/Button.tsx", relation: "imports", semanticOrigin: true, viaBarrel: "src/shared/components/index.ts" },
    ],
  };
  const fx = graphFile(graph);
  try {
    const hubs = tGodNodes(fx.graph, { top_n: 10 });
    assert.match(hubs, /Button\.tsx\s+\(2 unique/);
    assert.doesNotMatch(hubs, /index\.ts\s+\(/, "facade is not ranked as the architectural hub");

    const dependents = tGetDependents(fx.graph, { label: "src/ui/Button.tsx", depth: 2 });
    assert.match(dependents, /App\.tsx/);
    assert.match(dependents, /Page\.tsx/);
    assert.doesNotMatch(dependents, /index\.ts/, "reverse impact reports real consumers, not the facade hop");
    assert.match(tGetDependents(fx.graph, { label: "src/shared/components/index.ts", depth: 2 }), /No dependents found/);

    const aggregate = aggregateGraph(graph, null);
    assert.deepEqual(
      aggregate.moduleEdges.map(({ from, to, count }) => ({ from, to, count })),
      [
        { from: "src/app", to: "src/ui", count: 1 },
        { from: "src/page", to: "src/ui", count: 1 },
      ],
      "module rollup looks through the barrel instead of assigning coupling to it",
    );
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph preserves importer-to-imported direction when traversing from the imported seed", () => {
  const editor = { id: "src/widget/EditWidget.tsx", label: "EditWidget.tsx", source_file: "src/widget/EditWidget.tsx" };
  const store = { id: "src/store/useDynamicStore.ts", label: "useDynamicStore.ts", source_file: "src/store/useDynamicStore.ts" };
  const fx = graphFile({ nodes: [editor, store], links: [{ source: editor.id, target: store.id, relation: "imports" }] });
  try {
    const output = tQueryGraph(fx.graph, { question: "state", seed_files: [store.id], depth: 1 });
    assert.match(output, /EditWidget\.tsx --imports--> useDynamicStore\.ts/);
    assert.doesNotMatch(output, /useDynamicStore\.ts --imports--> EditWidget\.tsx/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("audit finding output exposes the complete representative cycle route", () => {
  const output = formatAuditFinding({
    severity: "medium", confidence: "high", rule: "circular-dep", title: "Circular dependency: 3 files",
    file: "a.ts", cycleRoute: "a.ts → b.ts → c.ts → a.ts", fixHint: "break one import",
  });
  assert.match(output, /route: a\.ts → b\.ts → c\.ts → a\.ts/);
});

test("audit finding output exposes dependency confidence reasons", () => {
  const output = formatAuditFinding({
    severity: "medium", confidence: "high", rule: "missing-dep", title: "Missing dependency: react-resizable",
    package: "react-resizable", reason: "A direct stylesheet import requires this package.",
  });
  assert.match(output, /\[medium\/high\]/);
  assert.match(output, /reason: A direct stylesheet import requires this package\./);
});

test("get_dependents keeps a real runtime path even when a shorter type-only path exists", () => {
  const fx = graphFile({
    edgeTypesV: 2,
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

test("get_dependents labels Rust compile-only paths without promoting them to runtime impact", () => {
  const fx = graphFile({
    edgeTypesV: 2,
    nodes: ["crate/src/lib.rs", "crate/src/api.rs"].map((id) => ({ id, label: id })),
    links: [
      { source: "crate/src/lib.rs", target: "crate/src/api.rs", relation: "imports", compileOnly: true },
    ],
  });
  try {
    const output = tGetDependents(fx.graph, { label: "crate/src/api.rs", depth: 1 });
    assert.match(output, /\[d1 compile-time\].*crate\/src\/lib\.rs/);
    assert.doesNotMatch(output, /\[d1 runtime\]/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("Java method ownership is structural in god_nodes and reverse impact", () => {
  const fx = graphFile({
    edgeTypesV: 2,
    nodes: [
      { id: "Child.java#Child@1", label: "Child" },
      { id: "Child.java#work@2", label: "work()" },
    ],
    links: [
      { source: "Child.java#Child@1", target: "Child.java#work@2", relation: "method" },
    ],
  });
  try {
    const godNodes = tGodNodes(fx.graph, { top_n: 10 });
    assert.match(godNodes, /Child\s+\(0 unique: 0 runtime, 0 compile-only;[^)]*owns 1 method\)/);
    assert.doesNotMatch(godNodes, /Child\s+\(1 unique/);
    assert.match(tGetDependents(fx.graph, { label: "work()", depth: 1 }), /No dependents found/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("graph_diff treats a method with only ownership remaining as newly orphaned", () => {
  const nodes = ["Child.java#Child@1", "Child.java#work@2", "Caller.java#call@1"].map((id) => ({ id }));
  const ownership = { source: nodes[0].id, target: nodes[1].id, relation: "method" };
  const oldGraph = { edgeTypesV: 2, nodes, links: [ownership, { source: nodes[2].id, target: nodes[1].id, relation: "calls" }] };
  const newGraph = { edgeTypesV: 2, nodes, links: [ownership] };
  assert.ok(diffGraphs(oldGraph, newGraph).orphaned.includes(nodes[1].id));
});

test("graph_diff calls an SCC shrink a membership change, not a newly introduced cycle", () => {
  const nodes = ["A", "B", "T"].map((id) => ({ id }));
  const oldGraph = {
    edgeTypesV: 2, nodes,
    links: [
      { source: "A", target: "B", relation: "imports" },
      { source: "B", target: "T", relation: "imports" },
      { source: "T", target: "A", relation: "imports" },
    ],
  };
  const newGraph = {
    edgeTypesV: 2, nodes,
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

test("graph_diff establishes a compile-time baseline instead of comparing legacy runtime classifications", () => {
  const nodes = [{ id: "A" }, { id: "B" }];
  const oldGraph = { edgeTypesV: 1, nodes, links: [{ source: "A", target: "B", relation: "imports" }] };
  const newGraph = { edgeTypesV: 2, nodes, links: [{ source: "A", target: "B", relation: "imports", compileOnly: true }] };
  const delta = diffGraphs(oldGraph, newGraph);
  assert.equal(delta.edges.added, 0);
  assert.equal(delta.edges.removed, 0);
  assert.equal(delta.cycles.runtime, null);
  assert.match(formatGraphDiff(delta), /compile-time baseline established/);
});

test("graph_diff does not call newly extractable Rust edges architecture drift during schema migration", () => {
  const nodes = ["crate/src/lib.rs", "crate/src/api/mod.rs"].map((id) => ({ id }));
  const oldGraph = { edgeTypesV: 1, nodes, links: [] };
  const newGraph = {
    edgeTypesV: 2,
    nodes,
    links: [{ source: nodes[0].id, target: nodes[1].id, relation: "imports", compileOnly: true }],
  };
  const delta = diffGraphs(oldGraph, newGraph);
  assert.deepEqual(delta.moduleEdges.added, []);
  assert.deepEqual(delta.moduleEdges.compileAdded, []);
  const output = formatGraphDiff(delta);
  assert.match(output, /schema upgraded/);
  assert.doesNotMatch(output, /NEW module dependencies|New compile-only module dependencies/);
});

test("graph_diff reports compile-only module drift separately from runtime architecture", () => {
  const nodes = ["crate/src/lib.rs", "crate/src/api/mod.rs"].map((id) => ({ id }));
  const oldGraph = { edgeTypesV: 2, nodes, links: [] };
  const newGraph = {
    edgeTypesV: 2,
    nodes,
    links: [{ source: nodes[0].id, target: nodes[1].id, relation: "imports", compileOnly: true }],
  };
  const delta = diffGraphs(oldGraph, newGraph);
  assert.deepEqual(delta.moduleEdges.added, []);
  assert.deepEqual(delta.moduleEdges.compileAdded, ["crate/src → crate/src/api"]);
  assert.match(formatGraphDiff(delta), /New compile-only module dependencies/);
  assert.doesNotMatch(formatGraphDiff(delta), /NEW module dependencies/);
});

test("module aggregation and module_map separate runtime, type-only, and compile-only dependencies", () => {
  const graph = {
    edgeTypesV: 2,
    nodes: [
      { id: "renderer/global.d.ts", source_file: "renderer/global.d.ts", file_type: "code" },
      { id: "main/preload.ts", source_file: "main/preload.ts", file_type: "code" },
      { id: "main/a.ts", source_file: "main/a.ts", file_type: "code" },
      { id: "shared/b.ts", source_file: "shared/b.ts", file_type: "code" },
      { id: "watcher-rs/src/lib.rs", source_file: "watcher-rs/src/lib.rs", file_type: "code" },
      { id: "watcher-rs/src/api/mod.rs", source_file: "watcher-rs/src/api/mod.rs", file_type: "code" },
    ],
    links: [
      { source: "renderer/global.d.ts", target: "main/preload.ts", relation: "imports", typeOnly: true },
      { source: "main/a.ts", target: "shared/b.ts", relation: "imports" },
      { source: "watcher-rs/src/lib.rs", target: "watcher-rs/src/api/mod.rs", relation: "imports", compileOnly: true },
    ],
  };
  const aggregate = aggregateGraph(graph, null);
  assert.deepEqual(aggregate.moduleEdges, [{ from: "main", to: "shared", count: 1 }]);
  assert.deepEqual(aggregate.typeOnlyModuleEdges, [{ from: "renderer", to: "main", count: 1 }]);
  assert.deepEqual(aggregate.compileOnlyModuleEdges, [{ from: "watcher-rs/src", to: "watcher-rs/src/api", count: 1 }]);
  assert.equal(aggregate.totals.compileTimeModuleEdges, 2);

  const fx = graphFile(graph);
  try {
    const output = tModuleMap(fx.graph, { top_n: 10 }, { graphPath: fx.path });
    assert.match(output, /Strongest runtime module dependencies:[\s\S]*main → shared/);
    assert.match(output, /Compile-time module dependencies[\s\S]*renderer → main  \(1; 1 type-only, 0 compile-only\)/);
    assert.match(output, /watcher-rs\/src → watcher-rs\/src\/api  \(1; 0 type-only, 1 compile-only\)/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
