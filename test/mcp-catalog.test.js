import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CAPS, loadHotApi } from "../src/mcp/catalog.mjs";

const names = (api) => new Set(api.tools.map((tool) => tool.name));

test("MCP profiles: absent caps use the offline default with explicit local retargeting", async () => {
  const api = await loadHotApi(0, undefined);
  const got = names(api);
  assert.deepEqual([...api.caps], [...DEFAULT_CAPS]);
  assert.equal(api.tools.length, 29);
  assert.ok(got.has("read_source"));
  assert.ok(got.has("rebuild_graph"));
  assert.ok(got.has("open_repo"));
  assert.ok(got.has("list_known_repos"));
  assert.ok(got.has("verify_architecture"));
  assert.ok(got.has("trace_api_contract"));
  assert.ok(!got.has("refresh_advisories"));
  assert.ok(!got.has("pull_architecture_contract"));
  assert.ok(!got.has("sync_graph"));
});

test("MCP profiles: offline is the named default and pinned removes retargeting", async () => {
  const offline = await loadHotApi(0, "offline");
  assert.deepEqual([...offline.caps], [...DEFAULT_CAPS]);
  assert.equal(offline.tools.length, 29);

  const api = await loadHotApi(0, "pinned");
  const got = names(api);
  assert.deepEqual([...api.caps], ["graph", "search", "source", "health", "build"]);
  assert.equal(api.tools.length, 26);
  assert.ok(got.has("read_source"));
  assert.ok(!got.has("open_repo"));
  assert.ok(!got.has("list_known_repos"));
  assert.ok(!got.has("trace_api_contract"));
  assert.ok(!got.has("refresh_advisories"));
  assert.ok(!got.has("pull_architecture_contract"));
  assert.ok(!got.has("sync_graph"));
});

test("MCP profiles: osv enables only advisory networking", async () => {
  const api = await loadHotApi(0, "osv");
  const got = names(api);
  assert.equal(api.tools.length, 30);
  assert.ok(got.has("open_repo"));
  assert.ok(got.has("refresh_advisories"));
  assert.ok(!got.has("pull_architecture_contract"));
  assert.ok(!got.has("sync_graph"));
});

test("MCP profiles: hosted and full expose the complete catalog", async () => {
  for (const profile of ["hosted", "full"]) {
    const api = await loadHotApi(0, profile);
    const got = names(api);
    assert.equal(api.tools.length, 32, profile);
    assert.ok(got.has("refresh_advisories"), profile);
    assert.ok(got.has("pull_architecture_contract"), profile);
    assert.ok(got.has("sync_graph"), profile);
  }
});

test("MCP capabilities: explicit groups select only their tools", async () => {
  const api = await loadHotApi(0, "retarget,online");
  assert.deepEqual(
    [...names(api)].sort(),
    ["list_known_repos", "open_repo", "pull_architecture_contract", "refresh_advisories", "sync_graph"].sort()
  );
});

test("MCP capabilities: legacy online remains an alias for advisories plus hosted", async () => {
  const api = await loadHotApi(0, "online");
  assert.deepEqual(
    [...names(api)].sort(),
    ["pull_architecture_contract", "refresh_advisories", "sync_graph"].sort()
  );
  assert.deepEqual([...api.caps], ["advisories", "hosted"]);
});

test("MCP capabilities: an explicit full capability selection exposes all tools", async () => {
  const api = await loadHotApi(0, `${DEFAULT_CAPS.join(",")},advisories,hosted`);
  assert.equal(api.tools.length, 32);
});

test("MCP capabilities: an explicit empty selection exposes no tools", async () => {
  const api = await loadHotApi(0, "");
  assert.equal(api.tools.length, 0);
});

test("query_graph schema exposes exact seed-file pinning", async () => {
  const api = await loadHotApi(0, "graph");
  const schema = api.byName.get("query_graph").inputSchema;
  assert.equal(schema.properties.seed_files.items.type, "string");
  assert.equal(schema.properties.seed_files.maxItems, 12);
  assert.equal(schema.properties.augment_seeds.default, false);
  assert.equal(schema.properties.output_format.enum[1], "json");
  assert.equal(api.byName.get("query_graph").outputSchema, undefined);
});

test("change_impact schema exposes bounded diff evidence and conservative file hints", async () => {
  const api = await loadHotApi(0, "graph");
  const tool = api.byName.get("change_impact");
  const schema = tool.inputSchema;
  assert.equal(schema.properties.diff.type, "string");
  assert.equal(schema.properties.diff.maxLength, 2 * 1024 * 1024);
  assert.equal(schema.properties.files.maxItems, 500);
  assert.match(schema.properties.files.description, /conservatively/i);
  assert.equal(tool.outputSchema, undefined);
});

test("run_audit schema distinguishes immutable baseline debt from changed-file scope", async () => {
  const api = await loadHotApi(0, "health");
  const schema = api.byName.get("run_audit").inputSchema;
  assert.equal(schema.properties.base_ref.type, "string");
  assert.equal(schema.properties.changed_files.maxItems, 500);
  assert.deepEqual(schema.properties.debt.enum, ["new", "existing", "all"]);
  assert.equal(schema.properties.debt.default, "new");
});

test("find_dead_code schema keeps risky surfaces opt-in and bounded", async () => {
  const api = await loadHotApi(0, "health");
  const tool = api.byName.get("find_dead_code");
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.min_confidence.default, "medium");
  assert.deepEqual(tool.inputSchema.properties.min_confidence.enum, ["high", "medium", "low"]);
  assert.equal(tool.inputSchema.properties.kinds.maxItems, 4);
  assert.equal(tool.inputSchema.properties.include_tests.default, false);
  assert.equal(tool.inputSchema.properties.include_classified.default, false);
  assert.equal(tool.inputSchema.properties.top_n.maximum, 100);
  assert.equal(tool.inputSchema.properties.output_format.enum[1], "json");
});

test("graph_diff schema exposes an immutable Git-ref baseline", async () => {
  const api = await loadHotApi(0, "graph");
  const schema = api.byName.get("graph_diff").inputSchema;
  assert.equal(schema.properties.base_ref.type, "string");
  assert.equal(schema.properties.base_ref.maxLength, 256);
  assert.match(schema.properties.base_ref.description, /never checks out/i);
  assert.equal(schema.properties.path.type, "string");
});

test("trace_api_contract schema is registry-scoped and exposes bounded backend-change filters", async () => {
  const api = await loadHotApi(0, "crossrepo");
  const tool = api.byName.get("trace_api_contract");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["backend", "clients"]);
  assert.equal(tool.inputSchema.properties.clients.maxItems, 20);
  assert.equal(tool.inputSchema.properties.changed_files.maxItems, 500);
  assert.equal(tool.inputSchema.properties.max_impact_depth.maximum, 5);
  assert.equal(tool.inputSchema.properties.path.maxLength, 2048);
  assert.equal(tool.inputSchema.properties.client_names.maxItems, 40);
  assert.equal(tool.inputSchema.properties.client_wrappers.maxItems, 100);
  assert.equal(tool.inputSchema.properties.client_wrappers.items.properties.url_argument.maximum, 5);
  assert.equal(tool.inputSchema.properties.auto_discover_wrappers.default, true);
  assert.equal(tool.inputSchema.properties.output_format.enum[1], "json");
});
