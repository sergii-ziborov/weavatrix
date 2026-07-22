import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGraph, diffGraphs, formatGraphDiff, findSeeds, prevGraphPathFor } from "../src/mcp/graph-context.mjs";
import { tGodNodes, tQueryGraph, tShortestPath } from "../src/mcp/tools-graph.mjs";
import { tGetDependents, tGraphDiff } from "../src/mcp/tools-impact.mjs";
import { auditFindingPathScope, tModuleMap, formatAuditFinding } from "../src/mcp/tools-health.mjs";
import { aggregateGraph } from "../src/analysis/graph-analysis.js";

function graphFile(graph) {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-signal-"));
  const path = join(dir, "graph.json");
  writeFileSync(path, JSON.stringify(graph));
  return { dir, path, graph: loadGraph(path) };
}

test("query_graph does not turn generic REST task instructions into config/path seeds", () => {
  const app = { id: "app.js", label: "app.js", source_file: "app.js" };
  const router = { id: "services/attack/attack.router.js", label: "attack.router.js", source_file: "services/attack/attack.router.js" };
  const controller = { id: "services/attack/attack.controller.js#startMitigate@10", label: "startMitigate()", source_file: "services/attack/attack.controller.js", symbol_kind: "function" };
  const configPath = { id: "jest.config.cjs#path@8", label: "path", source_file: "jest.config.cjs", symbol_kind: "variable" };
  const fx = graphFile({nodes: [app, router, controller, configPath], links: []});
  try {
    const output = tQueryGraph(fx.graph, {
      question: "Trace the main REST API request path from HTTP controller or route through service logic. Focus on production code and identify the best exact symbol to inspect.",
      depth: 1,
    }, {repoRoot: fx.dir});
    assert.doesNotMatch(output, /Seeds:.*\bpath\b/);
    assert.doesNotMatch(output, /jest\.config\.cjs/);
    assert.match(output, /attack\.router\.js|startMitigate/);
  } finally { rmSync(fx.dir, {recursive: true, force: true}); }
});

test("query_graph code-shaped identifiers outrank generic controller/service/flow concepts", () => {
  const controller = { id: "services/attack/attack.controller.js#startMitigate@10", label: "startMitigate()", source_file: "services/attack/attack.controller.js" };
  const service = { id: "services/attack/attack.service.js#startMitigate@20", label: "startMitigate()", source_file: "services/attack/attack.service.js" };
  const messaging = { id: "services/messaging/messaging.js#startMitigate@30", label: "startMitigate()", source_file: "services/messaging/messaging.js" };
  const wrongController = { id: "services/protected/protected.controller.js", label: "protected.controller.js", source_file: "services/protected/protected.controller.js" };
  const wrongService = { id: "services/protected/protected.service.js", label: "protected.service.js", source_file: "services/protected/protected.service.js" };
  const wrongFlow = { id: "services/keycloak/flowManagement.js", label: "flowManagement.js", source_file: "services/keycloak/flowManagement.js" };
  const fx = graphFile({nodes: [controller, service, messaging, wrongController, wrongService, wrongFlow], links: [
    {source: controller.id, target: service.id, relation: "calls"},
    {source: service.id, target: messaging.id, relation: "calls"},
  ]});
  try {
    const seeds = findSeeds(fx.graph, "inspect the exact REST request path and controller service flow for startMitigate", 6, {repoRoot: fx.dir});
    assert.deepEqual(seeds.map((node) => node.id).sort(), [controller.id, service.id, messaging.id].sort());
  } finally { rmSync(fx.dir, {recursive: true, force: true}); }
});

test("query_graph exact seed_files can pin non-product evidence despite production-first fuzzy ranking", () => {
  const production = { id: "src/mcp/tools-runner.mjs", label: "tools-runner.mjs", source_file: "src/mcp/tools-runner.mjs" };
  const fixture = { id: "benchmarks/fixtures/tool-runner.js", label: "tool-runner.js", source_file: "benchmarks/fixtures/tool-runner.js" };
  const fx = graphFile({ nodes: [production, fixture], links: [] });
  try {
    const output = tQueryGraph(fx.graph, { question: "tool execution", seed_files: [fixture.id], depth: 1 });
    assert.match(output, /Seeds: tool-runner\.js/);
    assert.match(output, /benchmarks\/fixtures\/tool-runner\.js/);
    assert.doesNotMatch(output, /Seeds:.*tools-runner\.mjs/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph keeps traversal production-only unless a class is explicitly requested", () => {
  const product = { id: "src/service.ts", label: "service.ts", source_file: "src/service.ts" };
  const testFile = { id: "test/service.test.ts", label: "service.test.ts", source_file: "test/service.test.ts" };
  const fx = graphFile({ nodes: [product, testFile], links: [{ source: testFile.id, target: product.id, relation: "imports" }] });
  try {
    const production = tQueryGraph(fx.graph, { question: "service architecture", seed_files: [product.id], depth: 1 }, { repoRoot: fx.dir });
    assert.doesNotMatch(production, /test\/service\.test\.ts/);
    assert.match(production, /Suppressed 1 classified\/non-product traversal node/);

    const explicitQuestion = tQueryGraph(fx.graph, { question: "service tests", seed_files: [product.id], depth: 1 }, { repoRoot: fx.dir });
    assert.match(explicitQuestion, /test\/service\.test\.ts/);

    const explicitFlag = tQueryGraph(fx.graph, { question: "service architecture", seed_files: [product.id], include_classified: true, depth: 1 }, { repoRoot: fx.dir });
    assert.match(explicitFlag, /test\/service\.test\.ts/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
test("query_graph does not treat a FlowSpec symbol as explicit test intent", () => {
  const source = { id: "src/flow.ts", label: "flow.ts", source_file: "src/flow.ts" };
  const flowSpec = { id: "src/flow.ts#FlowSpec@1", label: "FlowSpec", source_file: "src/flow.ts" };
  const testFile = { id: "test/flow.test.ts", label: "flow.test.ts", source_file: "test/flow.test.ts" };
  const fx = graphFile({ nodes: [source, flowSpec, testFile], links: [
    { source: source.id, target: flowSpec.id, relation: "contains" },
    { source: testFile.id, target: flowSpec.id, relation: "imports" },
  ] });
  try {
    const output = tQueryGraph(fx.graph, {
      question: "inspect FlowSpec architecture",
      seed_files: [flowSpec.source_file],
      depth: 2,
    }, {repoRoot: fx.dir});
    assert.doesNotMatch(output, /test\/flow\.test\.ts/);
    assert.match(output, /Suppressed 1 classified\/non-product traversal node/);
  } finally { rmSync(fx.dir, {recursive: true, force: true}); }
});

test("query_graph suppresses unmatched unreferenced constant leaves from exact file seeds", () => {
  const file = { id: "src/config.ts", label: "config.ts", source_file: "src/config.ts" };
  const handler = { id: "src/config.ts#loadConfig@1", label: "loadConfig()", source_file: "src/config.ts", symbol_kind: "function" };
  const noise = { id: "src/config.ts#UNRELATED_DEFAULT@9", label: "UNRELATED_DEFAULT", source_file: "src/config.ts", symbol_kind: "constant" };
  const fx = graphFile({
    nodes: [file, handler, noise],
    links: [
      { source: file.id, target: handler.id, relation: "contains" },
      { source: file.id, target: noise.id, relation: "contains" },
    ],
  });
  try {
    const focused = tQueryGraph(fx.graph, { question: "load config", seed_files: [file.id], depth: 1 }, { repoRoot: fx.dir });
    assert.match(focused, /loadConfig/);
    assert.doesNotMatch(focused, /UNRELATED_DEFAULT/);
    assert.match(focused, /Suppressed 1 unreferenced constant\/field node/);

    const expanded = tQueryGraph(fx.graph, { question: "load config", seed_files: [file.id], include_low_signal: true, depth: 1 }, { repoRoot: fx.dir });
    assert.match(expanded, /UNRELATED_DEFAULT/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
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

test("query_graph and shortest_path widen repeated or generic file basenames in edge lines", () => {
  const a = { id: "src/a/mod.rs", label: "mod.rs", source_file: "src/a/mod.rs" };
  const b = { id: "src/b/mod.rs", label: "mod.rs", source_file: "src/b/mod.rs" };
  const ambiguous = graphFile({ nodes: [a, b], links: [{ source: a.id, target: b.id, relation: "imports" }] });
  const engine = { id: "src/core/engine.rs", label: "engine.rs", source_file: "src/core/engine.rs" };
  const parser = { id: "src/core/parser.rs", label: "parser.rs", source_file: "src/core/parser.rs" };
  const unique = graphFile({ nodes: [engine, parser], links: [{ source: engine.id, target: parser.id, relation: "imports" }] });
  try {
    const output = tQueryGraph(ambiguous.graph, { question: "modules", seed_files: [a.id, b.id], depth: 1 });
    assert.match(output, /a\/mod\.rs --imports--> b\/mod\.rs/);
    const path = tShortestPath(ambiguous.graph, { source: a.id, target: b.id });
    assert.match(path, /a\/mod\.rs/);
    assert.match(path, /--imports--> b\/mod\.rs/);
    assert.match(path, /undirected connectivity/);
    assert.match(path, /arrows preserve stored graph direction/);
    assert.match(path, /from a\/mod\.rs to b\/mod\.rs/);
    const reversePath = tShortestPath(ambiguous.graph, { source: b.id, target: a.id });
    assert.match(reversePath, /b\/mod\.rs\s+<--imports-- a\/mod\.rs/);
    assert.doesNotMatch(reversePath, /b\/mod\.rs\s+--imports--> a\/mod\.rs/);

    const bare = tQueryGraph(unique.graph, { question: "core", seed_files: [engine.id, parser.id], depth: 1 });
    assert.match(bare, /engine\.rs --imports--> parser\.rs/, "unique basenames keep bare labels");
    assert.doesNotMatch(bare, /core\/engine\.rs --imports-->/);
  } finally {
    rmSync(ambiguous.dir, { recursive: true, force: true });
    rmSync(unique.dir, { recursive: true, force: true });
  }
});

test("query_graph preserves importer-to-imported direction when traversing from the imported seed", () => {
  const editor = { id: "src/widget/EditWidget.tsx", label: "EditWidget.tsx", source_file: "src/widget/EditWidget.tsx" };
  const store = { id: "src/store/useDynamicStore.ts", label: "useDynamicStore.ts", source_file: "src/store/useDynamicStore.ts" };
  const fx = graphFile({ nodes: [editor, store], links: [{ source: editor.id, target: store.id, relation: "imports" }] });
  try {
    const output = tQueryGraph(fx.graph, { question: "state", seed_files: [store.id], depth: 1 });
    assert.match(output, /EditWidget\.tsx --imports--> useDynamicStore\.ts/);
    assert.doesNotMatch(output, /useDynamicStore\.ts --imports--> EditWidget\.tsx/);
    const path = tShortestPath(fx.graph, { source: store.id, target: editor.id });
    assert.match(path, /useDynamicStore\.ts\s+<--imports-- EditWidget\.tsx/);
    assert.doesNotMatch(path, /useDynamicStore\.ts\s+--imports--> EditWidget\.tsx/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
