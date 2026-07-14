import { existsSync } from "node:fs";
import { runCommand } from "../process.js";

const quoteSh = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export async function commandAvailable(command, { timeoutMs = 5000 } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (/[\\/]/.test(cmd) || /^[A-Za-z]:[\\/]/.test(cmd)) return existsSync(cmd);
  try {
    const probe = process.platform === "win32"
      ? await runCommand("where.exe", [cmd], { timeoutMs })
      : await runCommand("sh", ["-lc", `command -v ${quoteSh(cmd)}`], { timeoutMs });
    return probe.exitCode === 0 && String(probe.stdout || "").trim().length > 0;
  } catch {
    return false;
  }
}

export function missingCommandMessage(manager) {
  const name = String(manager || "command").trim() || "command";
  return `${name} not found on PATH`;
}

// Resolve a bare command to its real .exe so runCommand can spawn it DIRECTLY (argv array, no cmd.exe).
// Corporate AV/EDR can block shell spawns whose long command line looks suspicious — seen live:
// `bun test … ./src/http/…itest.js` (30 args) through cmd.exe → spawn EPERM, while the identical
// direct bun.exe spawn runs fine. Direct spawn also sidesteps winQuote and cmd's ~8k line limit.
// Returns "" when the command isn't a resolvable .exe (npx.cmd shims etc. still need the shell).
export async function resolveExePath(command, { timeoutMs = 5000 } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd || process.platform !== "win32" || /\.exe$/i.test(cmd)) return "";
  if (/[\\/]/.test(cmd)) return ""; // explicit non-exe path — leave as the caller wrote it
  try {
    const probe = await runCommand("where.exe", [cmd], { timeoutMs });
    const hit = String(probe.stdout || "").split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
    return hit && existsSync(hit) ? hit : "";
  } catch {
    return "";
  }
}
