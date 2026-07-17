// Graph build — weavatrix's own web-tree-sitter builder.
// Emits <weavatrix-graphs/<repo>>/graph.json for the rest of the pipeline.
//
// The parse itself runs in a WORKER THREAD (build-worker.js): in-process it pinned Electron's main
// event loop for the whole repo walk, and since Windows routes window input through the main process
// the ENTIRE app froze on big repos. The worker writes graph.json itself and returns only counts +
// summaries. If the worker can't even start (exotic packaging), we fall back to the in-process build
// rather than lose the feature.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { childProcessEnv } from "./child-env.js";
import { graphHomeDir, graphOutDirForRepo, graphStorageKey, repoTopFolders, summarizeCommunities, summarizeHotspots, filterGraphForMode, filterGraphByScope } from "./graph/layout.js";
import { registerRepository } from "./graph/repo-registry.js";
import { refreshGraphIncrementally, snapshotRepository } from "./graph/incremental-refresh.js";
import { atomicWriteFileSync, withFileLock } from "./graph/file-lock.js";
import { graphSchemaIsCurrent, repositoryFreshnessProbe, stampRepositoryFreshness } from "./graph/freshness-probe.js";
import { buildLspPrecisionOverlay, invalidatePrecisionOverlay, precisionSummary } from "./precision/lsp-overlay.js";

// The worker path deadlocks web-tree-sitter's WASM in Electron's worker threads (fine in plain Node) — off
// until that's Electron-safe. In-process + event-loop yielding keeps the window responsive without it.
const USE_BUILD_WORKER = false;

// Hard ceiling so a wedged parse (WASM stuck, pathological file, symlink loop) can NEVER leave the UI on
// an eternal "BUILDING GRAPH…". On timeout we terminate the worker and reject as a REAL failure (no
// workerStartFailed → we do NOT fall back to the in-process build, which would hang the same way and
// freeze the whole app on the main thread). 4 min is generous for very large repos.
const BUILD_WORKER_TIMEOUT_MS = 4 * 60 * 1000;

export function defaultPrecisionMode(env = process.env) {
  return env?.WEAVATRIX_PRECISION === "off" ? "off" : "lsp";
}

function buildGraphInWorker(payload) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./graph/build-worker.js", import.meta.url), { workerData: payload, env: childProcessEnv() });
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

async function buildAndWriteInProcess(repoPath, { mode, scope, precision, graphJson, central }) {
  const { buildInternalGraph } = await import("./graph/internal-builder.js");
  // Capture the cheap Git state on both sides of the authoritative build. Only an unchanged pair is
  // safe to persist: if the working tree moves while parsing, the next process must take the slow path.
  const probeBefore = scope ? null : repositoryFreshnessProbe(repoPath);
  let graph;
  let refresh = null;
  if (mode === "full" && !scope && existsSync(graphJson)) {
    try {
      const existing = JSON.parse(readFileSync(graphJson, "utf8"));
      if (existing.graphBuildMode === "full" && !existing.graphBuildScope && graphSchemaIsCurrent(existing)) {
        refresh = await refreshGraphIncrementally(repoPath, existing, { buildGraph: buildInternalGraph });
        graph = refresh.graph;
      }
    } catch { /* malformed/legacy graph: the safe path below is a full rebuild */ }
  }
  if (!graph && mode !== "full" && !scope && existsSync(graphJson)) {
    try {
      const existing = JSON.parse(readFileSync(graphJson, "utf8"));
      if (existing.graphBuildMode === mode && existing.graphRevision && graphSchemaIsCurrent(existing)) {
        const snapshot = snapshotRepository(repoPath);
        if (snapshot.revision === existing.graphRevision) {
          graph = existing;
          refresh = { kind: "none", changedFiles: [], reason: "content-unchanged", revision: snapshot.revision };
        }
      }
    } catch { /* malformed/legacy filtered graph: rebuild below */ }
  }
  if (!graph) {
    graph = await buildInternalGraph(repoPath);
    refresh = { kind: "full", changedFiles: [], reason: "full-build-requested", revision: graph.graphRevision };
  }
  // mode (no-tests/tests-only) + path-scope reuse the same pure filters graph-builder used.
  if (mode === "no-tests" || mode === "tests-only") graph = filterGraphForMode(graph, mode, { repoRoot: repoPath });
  if (scope) graph = filterGraphByScope(graph, scope);
  graph.graphBuildMode = mode;
  graph.graphBuildScope = scope || "";
  const requestedPrecision = precision === "off" ? "off" : "lsp";
  const precisionModeChanged = graph.graphPrecisionMode !== requestedPrecision;
  graph.graphPrecisionMode = requestedPrecision;
  const probeAfter = scope ? null : repositoryFreshnessProbe(repoPath);
  const stableProbe = probeBefore && probeAfter === probeBefore ? probeAfter : null;
  const freshnessMetadataChanged = stampRepositoryFreshness(graph, stableProbe, mode);
  // Auto-refresh runs before every graph/health call. A no-op must not serialize and rewrite a
  // multi-megabyte graph merely to answer that nothing changed (or manufacture a newer mtime).
  // A one-time metadata-only write is intentional for legacy graphs so the next MCP process can use
  // the persisted probe instead of repeating a full repository snapshot.
  if (refresh?.kind !== "none" || freshnessMetadataChanged || precisionModeChanged) {
    mkdirSync(central, { recursive: true });
    atomicWriteFileSync(graphJson, JSON.stringify(graph), "utf8");
  }
  mkdirSync(central, { recursive: true });
  let precisionOverlay = await buildLspPrecisionOverlay({
    repoRoot: repoPath,
    graph,
    graphPath: graphJson,
    mode: requestedPrecision,
  });
  if (requestedPrecision === "lsp") {
    try {
      // LSP deliberately runs after graph serialization and can outlive the initial snapshot. A
      // complete second content snapshot catches source/config add-delete races (including Git
      // assume-unchanged paths) that a status-only token cannot prove away.
      if (snapshotRepository(repoPath).revision !== graph.graphRevision) {
        precisionOverlay = invalidatePrecisionOverlay(graphJson, graph);
      }
    } catch {
      precisionOverlay = invalidatePrecisionOverlay(
        graphJson,
        graph,
        "repository freshness could not be verified after semantic precision",
      );
    }
  }
  return {
    nodes: graph.nodes.length,
    links: graph.links.length,
    communities: summarizeCommunities(graphJson),
    hotspots: summarizeHotspots(graphJson),
    refresh,
    precision: precisionSummary(precisionOverlay),
  };
}

export async function buildGraphForRepo(repoPath, {
  mode = "full",
  scope = "",
  precision = defaultPrecisionMode(),
  outDir,
  graphHome,
} = {}) {
  if (!existsSync(repoPath)) return { ok: false, error: "Repo path not found", builder: "internal" };
  const registryHome = graphHome || graphHomeDir();
  const canonicalDir = graphHome ? join(registryHome, graphStorageKey(repoPath)) : graphOutDirForRepo(repoPath);
  const central = outDir || canonicalDir;
  const graphJson = join(central, "graph.json");
  try {
    // In-process is the ONLY path now. The worker (buildGraphInWorker) hung web-tree-sitter's WASM inside an
    // Electron worker thread → an eternal "BUILDING GRAPH…" for JS repos, even though the same code finishes
    // in ~3s on the main thread (and in a plain-Node worker). buildInternalGraph now YIELDS the event loop
    // between file chunks, so the main-thread parse no longer freezes the window — the reason the worker was
    // introduced. buildGraphInWorker/USE_BUILD_WORKER are kept for a future Electron-safe re-enable.
    const build = () => USE_BUILD_WORKER
      ? buildGraphInWorker({ repoPath, mode, scope, precision, graphJson, central }).catch((e) => {
          if (e && e.workerStartFailed) return buildAndWriteInProcess(repoPath, { mode, scope, precision, graphJson, central });
          throw e;
        })
      : buildAndWriteInProcess(repoPath, { mode, scope, precision, graphJson, central });
    // Canonical graphs are shared by all local MCP clients. Serialize the complete read/refresh/write
    // transaction so an older process cannot overwrite a newer incremental result.
    const canonical = !scope && resolve(central) === resolve(canonicalDir);
    const built = canonical
      ? await withFileLock(join(central, ".graph.lock"), build, { timeoutMs: 5 * 60_000, staleMs: 10 * 60_000 })
      : await build();
    // Scoped builds are disposable diagnostics under modules/<scope>; registering one would retarget
    // list_known_repos and cross-repo analysis away from the complete canonical graph.
    if (canonical) {
      registerRepository({ repoPath, graphDir: central, graphHome: registryHome });
    }
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
      refresh: built.refresh,
      precision: built.precision,
      log: `built-in builder: ${built.nodes} nodes, ${built.links} static links (${built.refresh?.kind || "full"}: ${built.refresh?.reason || "build"}); semantic precision ${built.precision?.state || "UNAVAILABLE"}, ${built.precision?.verifiedEdges || 0} EXACT_LSP edge(s)`
    };
  } catch (error) {
    return { ok: false, error: `graph build failed: ${error.message}`, builder: "internal" };
  }
}
