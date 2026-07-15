import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CAPS, loadHotApi } from "../src/mcp/catalog.mjs";

const names = (api) => new Set(api.tools.map((tool) => tool.name));

test("MCP capabilities: absent caps expose offline tools including convenient retargeting", async () => {
  const api = await loadHotApi(0, undefined);
  const got = names(api);
  assert.deepEqual([...api.caps], [...DEFAULT_CAPS]);
  assert.equal(api.tools.length, 21);
  assert.ok(got.has("read_source"));
  assert.ok(got.has("rebuild_graph"));
  assert.ok(got.has("open_repo"));
  assert.ok(got.has("list_known_repos"));
  assert.ok(!got.has("refresh_advisories"));
  assert.ok(!got.has("sync_graph"));
});

test("MCP capabilities: an explicit core-only selection pins one repository", async () => {
  const api = await loadHotApi(0, "graph,search,source,health,build");
  const got = names(api);
  assert.ok(got.has("read_source"));
  assert.ok(!got.has("open_repo"));
  assert.ok(!got.has("list_known_repos"));
  assert.ok(!got.has("sync_graph"));
});

test("MCP capabilities: explicit groups select only their tools", async () => {
  const api = await loadHotApi(0, "retarget,online");
  assert.deepEqual(
    [...names(api)].sort(),
    ["list_known_repos", "open_repo", "refresh_advisories", "sync_graph"].sort()
  );
});

test("MCP capabilities: explicit full selection exposes all available tools", async () => {
  const api = await loadHotApi(0, `${DEFAULT_CAPS.join(",")},online`);
  assert.equal(api.tools.length, 23);
});

test("MCP capabilities: an explicit empty selection exposes no tools", async () => {
  const api = await loadHotApi(0, "");
  assert.equal(api.tools.length, 0);
});
