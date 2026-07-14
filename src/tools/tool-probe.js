// External-tool availability for the Settings tab: is rg / npx actually installed? (graph-builder was
// removed — weavatrix builds every graph itself.) Cheap `where.exe` (win32) / `which` lookups — we
// never spawn the tools themselves — with a short timeout, a 60s in-module cache (re-renders must not
// re-spawn processes), and a NEVER-throws contract: a failed probe is just { ok:false, detail }. The
// pure evaluation half (evaluateProbe / firstFoundPath) is exported for tests; probeTools only gathers inputs.
import { existsSync } from "node:fs";
import { runCommand } from "../process.js";
import { resolveRgInfo } from "../scan/search.js";

const PROBE_TIMEOUT_MS = 3000;
const PROBE_CACHE_MS = 60000;

// pure: first usable path from `where`/`which` output (where.exe prints one match per line)
export function firstFoundPath(stdout) {
  return String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
}

// pure: raw probe inputs → { rg, npx } availability. A custom rgPath/editor-bundled/path rg counts
// as rg because the Search tab uses the same resolver. npx gates optional external deps tools.
export function evaluateProbe({ rgPath = "", rgOnPath = "", rgDetail = "", npxOnPath = "", exists = existsSync } = {}) {
  const customRg = rgPath && exists(rgPath) ? rgPath : "";
  const rg = customRg || rgOnPath
    ? { ok: true, detail: rgDetail || (customRg ? `custom path: ${customRg}` : rgOnPath) }
    : { ok: false, detail: "rg not found locally" };
  const npx = npxOnPath ? { ok: true, detail: npxOnPath } : { ok: false, detail: "npx not found on PATH" };
  return { rg, npx };
}

// Locate a command on PATH. where.exe is a real .exe so runCommand spawns it directly (no shell
// wrapping); POSIX uses `which`. Returns "" on any failure — never throws.
async function locateOnPath(name) {
  const [finder, args] = process.platform === "win32" ? ["where.exe", [name]] : ["which", [name]];
  try {
    const result = await runCommand(finder, args, { timeoutMs: PROBE_TIMEOUT_MS });
    return result.exitCode === 0 ? firstFoundPath(result.stdout) : "";
  } catch {
    return "";
  }
}

let _cache = null; // { key, at, result } — one entry is enough (only rgPath varies, and rarely)

// → { rg:{ok,detail}, npx:{ok,detail} }; cached 60s per rgPath, never throws.
export async function probeTools({ rgPath = "" } = {}) {
  const key = String(rgPath || "");
  if (_cache && _cache.key === key && Date.now() - _cache.at < PROBE_CACHE_MS) return _cache.result;
  const [rgInfo, npxOnPath] = await Promise.all([resolveRgInfo("system", key), locateOnPath("npx")]);
  const result = evaluateProbe({ rgPath: key, rgOnPath: rgInfo?.path || "", rgDetail: rgInfo?.detail || "", npxOnPath });
  _cache = { key, at: Date.now(), result };
  return result;
}
