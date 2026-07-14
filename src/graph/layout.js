// Graph paths + analysis re-exports. This module owns the on-disk graph locations and re-exports the
// pure filter/analysis helpers so callers get everything from one import:
//   graph-filter.js   — pure graph filters (test-mode, path-scope)
//   graph-analysis.js — parse graph.json → file/module/symbol view, hotspots, communities
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { repoBaseName } from "../scan/discover.js";

export * from "./graph-filter.js";
export * from "../analysis/graph-analysis.js";

// Graphs live in a `weavatrix-graphs/` folder NEXT to the repo (inside the repo's parent folder),
// never inside the repo itself — the graph is derived data, not source. One folder per repo holds
// graph.json plus graph.prev.json (saved by rebuild_graph for graph_diff).
export function graphOutDirForRepo(repoPath) {
  return join(dirname(repoPath), "weavatrix-graphs", repoBaseName(repoPath));
}

// A separate dir for a single module's scoped graph, so it never clobbers the repo's graph.
export function graphOutDirForModule(repoPath, moduleName) {
  const safe = String(moduleName).replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(dirname(repoPath), "weavatrix-graphs", repoBaseName(repoPath), "modules", safe);
}

// Top-level source folders of a repo (for path-scoped builds).
export function repoTopFolders(repoPath) {
  try {
    return readdirSync(repoPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "weavatrix-graphs", "dist", "build", "coverage", "vendor"].includes(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}
