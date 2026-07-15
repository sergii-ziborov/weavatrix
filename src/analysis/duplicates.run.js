// duplicates.run.js — the repos:duplicates entry point (split from duplicates.js): worker-thread
// offload with in-process fallback, cached per (repo, graph.json mtime).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { graphOutDirForRepo } from "../graph/layout.js";
import { computeDuplicates } from "./duplicates.compute.js";

function computeInWorker(repoPath, graphJsonPath) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./duplicates-worker.js", import.meta.url), { workerData: { repoPath, graphJsonPath } });
    } catch (e) {
      reject(Object.assign(e, { workerStartFailed: true }));
      return;
    }
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    worker.once("message", (msg) => done(resolve, msg));
    worker.once("error", (e) => done(reject, Object.assign(e, { workerStartFailed: true })));
    worker.once("exit", (code) => { if (code !== 0) done(reject, Object.assign(new Error(`duplicates worker exited with code ${code}`), { workerStartFailed: true })); });
  });
}

// repos:duplicates entry — cached per (repo, graph.json mtime): re-running with an unchanged graph is
// free. `force` (the UI's ↻ rescan) bypasses the cache: fragment BODIES are read from live source, so a
// source edit that didn't rebuild the graph (same mtime) must still be re-scanned on demand.
const _cache = new Map();
export async function runDuplicates(repoPath, force = false) {
  const repo = String(repoPath || "");
  if (!repo || !existsSync(repo)) return { ok: false, error: "Repo path not found" };
  const graphJsonPath = join(graphOutDirForRepo(repo), "graph.json");
  if (!existsSync(graphJsonPath)) {
    return { ok: false, needsGraph: true, error: "No graph yet — build the Relations graph first (↻ on the Relations tab)" };
  }
  let mtime = 0;
  try { mtime = statSync(graphJsonPath).mtimeMs; } catch { /* treat as uncached */ }
  const cached = _cache.get(repo);
  if (!force && cached && cached.mtime === mtime) return cached.result;
  let result;
  try {
    result = await computeInWorker(repo, graphJsonPath);
  } catch (e) {
    if (!e || !e.workerStartFailed) return { ok: false, error: e.message || String(e) };
    try { result = computeDuplicates(repo, graphJsonPath); } // in-process fallback (exotic packaging)
    catch (e2) { return { ok: false, error: e2.message || String(e2) }; }
  }
  if (result && result.ok) _cache.set(repo, { mtime, result });
  return result;
}
