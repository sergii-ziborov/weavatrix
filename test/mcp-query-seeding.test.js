import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGraph, diffGraphs, formatGraphDiff, findSeeds, prevGraphPathFor } from "../src/mcp/graph-context.mjs";
import { tGodNodes, tQueryGraph } from "../src/mcp/tools-graph.mjs";
import { tGetDependents, tGraphDiff } from "../src/mcp/tools-impact.mjs";
import { auditFindingPathScope, tModuleMap, formatAuditFinding } from "../src/mcp/tools-health.mjs";
import { aggregateGraph } from "../src/analysis/graph-analysis.js";

function graphFile(graph) {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-signal-"));
  const path = join(dir, "graph.json");
  writeFileSync(path, JSON.stringify(graph));
  return { dir, path, graph: loadGraph(path) };
}

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

test("query_graph honors an explicit language in mixed-language repositories", () => {
  const nodes = [
    {id: "rust-server/src/server.rs", label: "server.rs", source_file: "rust-server/src/server.rs"},
    {id: "python/server.py", label: "server.py", source_file: "python/server.py"},
    {id: "web/server.ts", label: "server.ts", source_file: "web/server.ts"},
    {id: "templates/rust-server.js", label: "rust-server.js", source_file: "templates/rust-server.js"},
  ];
  const fx = graphFile({nodes, links: []});
  try {
    const rust = findSeeds(fx.graph, "Explain the Rust server architecture", 8).map((node) => node.id);
    assert.deepEqual(rust, ["rust-server/src/server.rs"]);
    const both = findSeeds(fx.graph, "Compare the Rust and TypeScript server", 8).map((node) => node.id);
    assert.ok(both.includes("rust-server/src/server.rs"));
    assert.ok(both.includes("web/server.ts"));
    assert.ok(!both.includes("python/server.py"));
    assert.ok(!both.includes("templates/rust-server.js"));
  } finally { rmSync(fx.dir, {recursive: true, force: true}); }
});

test("query_graph broad bootstrap and tool-execution seeds prefer executable production evidence", () => {
  const product = [
    { id: "bin/weavatrix-mcp.mjs", label: "weavatrix-mcp.mjs", source_file: "bin/weavatrix-mcp.mjs" },
    { id: "src/mcp-server.mjs", label: "mcp-server.mjs", source_file: "src/mcp-server.mjs" },
    { id: "src/mcp/catalog.mjs", label: "catalog.mjs", source_file: "src/mcp/catalog.mjs" },
    { id: "src/mcp/tools-graph.mjs", label: "tools-graph.mjs", source_file: "src/mcp/tools-graph.mjs" },
    { id: "src/mcp/tool-result.mjs", label: "tool-result.mjs", source_file: "src/mcp/tool-result.mjs" },
  ];
  const noise = [
    { id: "server.json", label: "server.json", source_file: "server.json" },
    { id: "site/index.html", label: "index.html", source_file: "site/index.html" },
    { id: "docs/tool-execution.md", label: "tool-execution.md", source_file: "docs/tool-execution.md" },
    { id: "benchmarks/fixtures/tool-runner.js", label: "tool-runner.js", source_file: "benchmarks/fixtures/tool-runner.js" },
    { id: "test/tool-execution.test.js", label: "tool-execution.test.js", source_file: "test/tool-execution.test.js" },
  ];
  const fx = graphFile({
    nodes: [...product, ...noise],
    links: [
      { source: product[0].id, target: product[1].id, relation: "imports" },
      { source: product[1].id, target: product[2].id, relation: "imports" },
      { source: product[2].id, target: product[3].id, relation: "imports" },
      { source: product[1].id, target: product[4].id, relation: "imports" },
    ],
  });
  try {
    const seeds = findSeeds(fx.graph, "How does bootstrap and tool execution work?", 5).map((node) => node.id);
    assert.deepEqual(seeds, [
      "bin/weavatrix-mcp.mjs",
      "src/mcp/catalog.mjs",
      "src/mcp-server.mjs",
      "src/mcp/tool-result.mjs",
      "src/mcp/tools-graph.mjs",
    ]);
    assert.ok(seeds.every((id) => product.some((node) => node.id === id)), "metadata, site, docs, fixtures, and tests stay out of the default seeds");
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph treats frontend application startup as bootstrap instead of a feature-name match", () => {
  const main = { id: "src/main.tsx", label: "main.tsx", source_file: "src/main.tsx" };
  const root = { id: "src/index.tsx", label: "index.tsx", source_file: "src/index.tsx" };
  const wrapper = { id: "src/apps/TopApplicationsWrapper.tsx", label: "TopApplicationsWrapper", source_file: "src/apps/TopApplicationsWrapper.tsx" };
  const mapper = { id: "src/apps/top-applications.ts#mapTopApplication@12", label: "mapTopApplication()", source_file: "src/apps/top-applications.ts" };
  const releaseHelper = { id: "scripts/verify-release.mjs#server@8", label: "server", source_file: "scripts/verify-release.mjs" };
  const temporaryMain = { id: ".tmp-release/fixture/src/main.ts", label: "main.ts", source_file: ".tmp-release/fixture/src/main.ts" };
  const helpers = Array.from({ length: 20 }, (_, index) => ({
    id: `src/apps/application-helper-${index}.ts`, label: `application-helper-${index}.ts`, source_file: `src/apps/application-helper-${index}.ts`,
  }));
  const fx = graphFile({
    nodes: [main, root, wrapper, mapper, releaseHelper, temporaryMain, ...helpers],
    links: [
      { source: main.id, target: root.id, relation: "imports" },
      ...helpers.map((helper) => ({ source: wrapper.id, target: helper.id, relation: "imports" })),
      ...helpers.map((helper) => ({ source: mapper.id, target: helper.id, relation: "calls" })),
    ],
  });
  try {
    const seeds = findSeeds(fx.graph, "How does application startup work?", 4).map((node) => node.id);
    assert.deepEqual(seeds.slice(0, 2), [main.id, root.id]);
    assert.ok(!seeds.slice(0, 2).includes(wrapper.id), "TopApplicationsWrapper cannot displace the real startup files despite its higher degree");
    assert.ok(!seeds.slice(0, 2).includes(mapper.id), "mapTopApplication cannot displace the real startup files despite its higher degree");
    assert.ok(!seeds.includes(releaseHelper.id), "release-script locals stay out of broad application-startup seeds");
    assert.ok(!seeds.includes(temporaryMain.id), "temporary fixture entry points are classified out by default");
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph tool intent does not substring-match Tooltip components", () => {
  const catalog = { id: "src/mcp/catalog.mjs", label: "catalog.mjs", source_file: "src/mcp/catalog.mjs" };
  const tools = { id: "src/mcp/tools-actions.mjs", label: "tools-actions.mjs", source_file: "src/mcp/tools-actions.mjs" };
  const tooltip = { id: "src/ui/Tooltip.tsx", label: "Tooltip", source_file: "src/ui/Tooltip.tsx" };
  const rangesTooltip = { id: "src/chart/RangesTooltip.tsx#RangesTooltip@9", label: "RangesTooltip()", source_file: "src/chart/RangesTooltip.tsx" };
  const helpers = Array.from({ length: 20 }, (_, index) => ({ id: `src/ui/helper-${index}.tsx`, label: `helper-${index}.tsx`, source_file: `src/ui/helper-${index}.tsx` }));
  const fx = graphFile({
    nodes: [catalog, tools, tooltip, rangesTooltip, ...helpers],
    links: [
      { source: catalog.id, target: tools.id, relation: "imports" },
      ...helpers.map((helper) => ({ source: tooltip.id, target: helper.id, relation: "imports" })),
      ...helpers.map((helper) => ({ source: rangesTooltip.id, target: helper.id, relation: "calls" })),
    ],
  });
  try {
    const seeds = findSeeds(fx.graph, "tool execution", 8).map((node) => node.id);
    assert.deepEqual(seeds, [catalog.id, tools.id]);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph admits a classified surface only when the question asks for it", () => {
  const product = { id: "src/mcp/tools-runner.mjs", label: "tools-runner.mjs", source_file: "src/mcp/tools-runner.mjs" };
  const benchmark = { id: "benchmarks/tool-execution.js", label: "tool-execution.js", source_file: "benchmarks/tool-execution.js" };
  const testFile = { id: "test/tool-execution.test.js", label: "tool-execution.test.js", source_file: "test/tool-execution.test.js" };
  const fx = graphFile({ nodes: [product, benchmark, testFile], links: [] });
  try {
    assert.deepEqual(findSeeds(fx.graph, "tool execution", 3).map((node) => node.id), [product.id]);
    assert.ok(findSeeds(fx.graph, "benchmark tool execution", 3).some((node) => node.id === benchmark.id));
    assert.ok(findSeeds(fx.graph, "test tool execution", 3).some((node) => node.id === testFile.id));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("query_graph uses repository path classification and product overrides", () => {
  const product = { id: "src/mcp/tools-runner.mjs", label: "tools-runner.mjs", source_file: "src/mcp/tools-runner.mjs" };
  const customBenchmark = { id: "custom-perf/tools-runner.mjs", label: "tools-runner.mjs", source_file: "custom-perf/tools-runner.mjs" };
  const promotedBenchmark = { id: "benchmarks/product/tools-runner.mjs", label: "tools-runner.mjs", source_file: "benchmarks/product/tools-runner.mjs" };
  const fx = graphFile({ nodes: [product, customBenchmark, promotedBenchmark], links: [] });
  writeFileSync(join(fx.dir, ".weavatrix.json"), JSON.stringify({
    classify: {
      benchmark: ["custom-perf/**"],
      product: ["benchmarks/product/**"],
    },
  }));
  try {
    const output = tQueryGraph(fx.graph, { question: "tool execution", depth: 1 }, { repoRoot: fx.dir });
    assert.match(output, /src\/mcp\/tools-runner\.mjs/);
    assert.match(output, /benchmarks\/product\/tools-runner\.mjs/, "classify.product keeps a benchmark-root runtime tool in production queries");
    assert.doesNotMatch(output, /custom-perf\/tools-runner\.mjs/, "repository-defined benchmark paths are suppressed by default");

    const explicit = tQueryGraph(fx.graph, { question: "benchmark tool execution", depth: 1 }, { repoRoot: fx.dir });
    assert.match(explicit, /custom-perf\/tools-runner\.mjs/, "an explicit benchmark question can opt the custom class back in");
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

test("query_graph exact seed_symbols support relation filters and directed flow", () => {
  const controller = { id: "src/controller.ts#start@1", label: "start()", source_file: "src/controller.ts" };
  const service = { id: "src/service.ts#mitigate@1", label: "mitigate()", source_file: "src/service.ts" };
  const caller = { id: "src/router.ts#route@1", label: "route()", source_file: "src/router.ts" };
  const duplicate = { id: "src/other.ts#start@1", label: "start()", source_file: "src/other.ts" };
  const fx = graphFile({nodes: [controller, service, caller, duplicate], links: [
    {source: caller.id, target: controller.id, relation: "calls"},
    {source: controller.id, target: service.id, relation: "calls"},
    {source: controller.id, target: service.id, relation: "imports"},
    {source: service.id, target: duplicate.id, relation: "imports"},
  ]});
  try {
    const forward = tQueryGraph(fx.graph, {
      question: "trace mitigation",
      seed_symbols: [controller.id],
      relation_filter: ["calls"],
      flow_direction: "forward",
      depth: 2,
    });
    assert.match(forward, /flow forward, relations calls/);
    assert.match(forward, /mitigate\(\)/);
    assert.doesNotMatch(forward, /route\(\)/);
    assert.doesNotMatch(forward, /other\.ts/);

    const backward = tQueryGraph(fx.graph, {
      seed_symbols: [service.id], relation_filter: "calls", flow_direction: "backward", depth: 2,
    });
    assert.match(backward, /start\(\)/);
    assert.match(backward, /route\(\)/);

    const ambiguous = tQueryGraph(fx.graph, {seed_symbols: ["start"], flow_direction: "forward"});
    assert.match(ambiguous, /Ambiguous exact symbols: start \(2 exact matches; pass a symbol id\)/);
  } finally { rmSync(fx.dir, {recursive: true, force: true}); }
});

test("query_graph falls back instead of returning nothing for an all-stop concept or impossible language", () => {
  const nodes = [
    { id: "src/analysis/architecture/contract-verification.js", label: "contract-verification.js", source_file: "src/analysis/architecture/contract-verification.js" },
    { id: "src/mcp/architecture-bootstrap.mjs", label: "architecture-bootstrap.mjs", source_file: "src/mcp/architecture-bootstrap.mjs" },
    { id: "src/analysis/architecture/contract-verification.js#verifyArchitecture@9", label: "verifyArchitecture()", source_file: "src/analysis/architecture/contract-verification.js" },
    { id: "src/other/unrelated.js", label: "unrelated.js", source_file: "src/other/unrelated.js" },
  ];
  const fx = graphFile({ nodes, links: [] });
  try {
    // "architecture" is entirely stop-worded; the relax-stop fallback still seeds architecture nodes
    const arch = findSeeds(fx.graph, "architecture", 5).map((node) => node.id);
    assert.ok(arch.length > 0, "a bare architecture concept must not return zero seeds");
    assert.ok(arch.some((id) => id.includes("architecture")), "seeds an architecture node");
    // "contract" infers Solidity, but there are no .sol files here -> the language filter is dropped
    const contract = findSeeds(fx.graph, "contract", 5).map((node) => node.id);
    assert.ok(contract.some((id) => id.includes("contract")), "a contract query in a non-Solidity repo still seeds contract nodes");
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

