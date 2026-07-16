// build-worker.js — runs the web-tree-sitter graph build OFF Electron's main thread. In-process the
// parse blocks the main event loop for the whole repo walk (big repos = many seconds), and on Windows
// window input routing lives on the main process — so the ENTIRE app froze during "BUILDING THE
// GRAPH…". The worker builds, filters, writes graph.json and computes the summaries; only the small
// result object crosses back (never the graph itself — structured-cloning a huge graph would stall
// the main thread again).
import { parentPort, workerData } from "node:worker_threads";
import { buildInternalGraph } from "./internal-builder.js";
import { filterGraphForMode, filterGraphByScope, summarizeCommunities, summarizeHotspots } from "./layout.js";
import { atomicWriteFileSync } from "./file-lock.js";

(async () => {
  const { repoPath, mode, scope, graphJson, central } = workerData || {};
  try {
    let graph = await buildInternalGraph(repoPath);
    if (mode === "no-tests" || mode === "tests-only") graph = filterGraphForMode(graph, mode, { repoRoot: repoPath });
    if (scope) graph = filterGraphByScope(graph, scope);
    atomicWriteFileSync(graphJson, JSON.stringify(graph), "utf8");
    parentPort.postMessage({
      ok: true,
      nodes: graph.nodes.length,
      links: graph.links.length,
      communities: summarizeCommunities(graphJson),
      hotspots: summarizeHotspots(graphJson),
    });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
  }
})();
