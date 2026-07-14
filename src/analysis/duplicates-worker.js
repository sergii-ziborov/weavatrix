// duplicates-worker.js — runs clone detection OFF Electron's main thread (same rationale as
// graph/build-worker.js: a blocked main event loop freezes every window on Windows). The fingerprint
// sets never leave the worker; only slim fragment metadata + similarity pairs cross back.
import { parentPort, workerData } from "node:worker_threads";
import { computeDuplicates } from "./duplicates.js";

try {
  parentPort.postMessage(computeDuplicates(workerData.repoPath, workerData.graphJsonPath));
} catch (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
}
