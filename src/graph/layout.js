// Graph paths + analysis re-exports. This module owns the on-disk graph locations and re-exports the
// pure filter/analysis helpers so callers get everything from one import:
//   graph-filter.js   — pure graph filters (test-mode, path-scope)
//   graph-analysis.js — parse graph.json → file/module/symbol view, hotspots, communities
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { readdirSync, realpathSync } from "node:fs";

export * from "./graph-filter.js";
export * from "../analysis/graph-analysis.js";

// Graphs live in a `weavatrix-graphs/` folder NEXT to the repo (inside the repo's parent folder),
// never inside the repo itself — the graph is derived data, not source. One folder per repo holds
// graph.json plus graph.prev.json (saved by rebuild_graph for graph_diff).
export function graphHomeDir() {
  return resolve(process.env.WEAVATRIX_GRAPH_HOME || join(homedir(), ".weavatrix", "graphs"));
}

export function graphStorageKey(repoPath) {
  let absolute;
  try { absolute = realpathSync.native(repoPath); }
  catch { absolute = resolve(repoPath); }
  const normalized = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const slug = (basename(absolute) || "repo").replace(/[^A-Za-z0-9_.-]/g, "_");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}

export function graphOutDirForRepo(repoPath) {
  return join(graphHomeDir(), graphStorageKey(repoPath));
}

// A separate dir for a single module's scoped graph, so it never clobbers the repo's graph.
export function graphOutDirForModule(repoPath, moduleName) {
  const safe = String(moduleName).replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(graphOutDirForRepo(repoPath), "modules", safe);
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
