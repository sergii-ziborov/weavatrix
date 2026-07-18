import test from "node:test";
import assert from "node:assert/strict";
import { loadHotApi } from "../src/mcp/catalog.mjs";

// Repo Lens is Weavatrix's source-product baseline, not a competitor. Keep every
// portable Repo Lens analyzer available in the default offline MCP profile.
// app_action/app_job_status are intentionally excluded: they control Repo Lens's
// Electron process rather than providing repository-analysis semantics.
const REPO_LENS_PORTABLE_BASELINE = Object.freeze([
  "graph_stats",
  "get_node",
  "get_neighbors",
  "get_dependents",
  "change_impact",
  "graph_diff",
  "query_graph",
  "god_nodes",
  "shortest_path",
  "get_community",
  "list_communities",
  "module_map",
  "list_known_repos",
  "run_audit",
  "find_duplicates",
  "coverage_map",
  "read_source",
  "search_code",
  "list_endpoints",
  "rebuild_graph",
  "open_repo",
]);

test("default MCP profile never regresses below the portable Repo Lens baseline", async () => {
  const api = await loadHotApi(0, "offline");
  const available = new Set(api.tools.map((tool) => tool.name));
  const missing = REPO_LENS_PORTABLE_BASELINE.filter((name) => !available.has(name));

  assert.deepEqual(
    missing,
    [],
    `Weavatrix release regression: missing Repo Lens baseline tools: ${missing.join(", ")}`
  );
});

test("Repo Lens app analysis actions retain direct portable MCP paths", async () => {
  const api = await loadHotApi(0, "full");
  const available = new Set(api.tools.map((tool) => tool.name));
  const scenarioPaths = {
    rebuild_graph: ["rebuild_graph"],
    run_health: ["run_audit"],
    refresh_advisories: ["refresh_advisories"],
    measure_coverage: ["verified_change", "coverage_map"],
    find_duplicates: ["find_duplicates"],
  };
  for (const [scenario, path] of Object.entries(scenarioPaths)) {
    assert.ok(path.every((name) => available.has(name)),
      `${scenario} lost its direct MCP capability path: ${path.join(" -> ")}`);
  }
});
