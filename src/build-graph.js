// Graph build — weavatrix's own web-tree-sitter builder.
// Emits <weavatrix-graphs/<repo>>/graph.json for the rest of the pipeline.
//
// The parse itself runs in a WORKER THREAD (build-worker.js): in-process it pinned Electron's main
// event loop for the whole repo walk, and since Windows routes window input through the main process
// the ENTIRE app froze on big repos. The worker writes graph.json itself and returns only counts +
// summaries. If the worker can't even start (exotic packaging), we fall back to the in-process build
// rather than lose the feature.
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { graphOutDirForRepo, repoTopFolders, summarizeCommunities, summarizeHotspots, filterGraphForMode, filterGraphByScope } from "./graph/layout.js";

// The worker path deadlocks web-tree-sitter's WASM in Electron's worker threads (fine in plain Node) — off
// until that's Electron-safe. In-process + event-loop yielding keeps the window responsive without it.
const USE_BUILD_WORKER = false;

// Hard ceiling so a wedged parse (WASM stuck, pathological file, symlink loop) can NEVER leave the UI on
// an eternal "BUILDING GRAPH…". On timeout we terminate the worker and reject as a REAL failure (no
// workerStartFailed → we do NOT fall back to the in-process build, which would hang the same way and
// freeze the whole app on the main thread). 4 min is generous for very large repos.
const BUILD_WORKER_TIMEOUT_MS = 4 * 60 * 1000;

function buildGraphInWorker(payload) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./graph/build-worker.js", import.meta.url), { workerData: payload });
    } catch (e) {
      reject(Object.assign(e, { workerStartFailed: true }));
      return;
    }
    let settled = false;
    let timer = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      fn(v);
    };
    timer = setTimeout(() => {
      try { worker.terminate(); } catch { /* already gone */ }
      done(reject, new Error(`graph build timed out after ${Math.round(BUILD_WORKER_TIMEOUT_MS / 1000)}s (the parser is wedged on this repo — try again, or report it)`));
    }, BUILD_WORKER_TIMEOUT_MS);
    worker.once("message", (msg) => {
      if (msg && msg.ok) done(resolve, msg);
      else done(reject, new Error((msg && msg.error) || "graph worker failed"));
    });
    worker.once("error", (e) => done(reject, Object.assign(e, { workerStartFailed: true })));
    worker.once("exit", (code) => { if (code !== 0) done(reject, Object.assign(new Error(`graph worker exited with code ${code}`), { workerStartFailed: true })); });
  });
}

async function buildAndWriteInProcess(repoPath, { mode, scope, graphJson, central }) {
  const { buildInternalGraph } = await import("./graph/internal-builder.js");
  let graph = await buildInternalGraph(repoPath);
  // mode (no-tests/tests-only) + path-scope reuse the same pure filters graph-builder used.
  if (mode === "no-tests" || mode === "tests-only") graph = filterGraphForMode(graph, mode);
  if (scope) graph = filterGraphByScope(graph, scope);
  mkdirSync(central, { recursive: true });
  writeFileSync(graphJson, JSON.stringify(graph), "utf8");
  return {
    nodes: graph.nodes.length,
    links: graph.links.length,
    communities: summarizeCommunities(graphJson),
    hotspots: summarizeHotspots(graphJson),
  };
}

export async function buildGraphForRepo(repoPath, { mode = "full", scope = "", outDir } = {}) {
  if (!existsSync(repoPath)) return { ok: false, error: "Repo path not found", builder: "internal" };
  const central = outDir || graphOutDirForRepo(repoPath);
  const graphJson = join(central, "graph.json");
  try {
    // In-process is the ONLY path now. The worker (buildGraphInWorker) hung web-tree-sitter's WASM inside an
    // Electron worker thread → an eternal "BUILDING GRAPH…" for JS repos, even though the same code finishes
    // in ~3s on the main thread (and in a plain-Node worker). buildInternalGraph now YIELDS the event loop
    // between file chunks, so the main-thread parse no longer freezes the window — the reason the worker was
    // introduced. buildGraphInWorker/USE_BUILD_WORKER are kept for a future Electron-safe re-enable.
    const built = USE_BUILD_WORKER
      ? await buildGraphInWorker({ repoPath, mode, scope, graphJson, central }).catch((e) => {
          if (e && e.workerStartFailed) return buildAndWriteInProcess(repoPath, { mode, scope, graphJson, central });
          throw e;
        })
      : await buildAndWriteInProcess(repoPath, { mode, scope, graphJson, central });
    return {
      ok: true,
      builder: "internal",
      mode,
      scope,
      topFolders: repoTopFolders(repoPath),
      report: "",
      graphFile: "", // no graph.html — weavatrix renders its own GUI board/relations views
      graphDir: central,
      communities: built.communities,
      hotspots: built.hotspots,
      log: `built-in builder: ${built.nodes} nodes, ${built.links} links`
    };
  } catch (error) {
    return { ok: false, error: `graph build failed: ${error.message}`, builder: "internal" };
  }
}
