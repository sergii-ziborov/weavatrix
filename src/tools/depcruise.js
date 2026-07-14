// dependency-cruiser: validate a repo's module dependencies — circular deps, orphan modules, and
// (if the repo ships its own .dependency-cruiser config) its custom architectural-boundary rules.
// Run via bunx with the real package name (`depcruise` alone is a dependency-confusion placeholder),
// scoped to a subfolder so you can analyze just one part of a project. Nothing is written into the repo.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPCRUISE_TIMEOUT_MS } from "../config.js";
import { runCommand } from "../process.js";
import { repoTopFolders } from "../graph/layout.js";

const DEFAULT_CONFIG = fileURLToPath(new URL("depcruise.config.cjs", import.meta.url));

const REPO_CONFIG_NAMES = [
  ".dependency-cruiser.json",
  ".dependency-cruiser.js",
  ".dependency-cruiser.cjs",
  ".dependency-cruiser.mjs",
  ".dependency-cruiser.ts"
];

function repoHasOwnConfig(repoPath) {
  return REPO_CONFIG_NAMES.some((name) => existsSync(join(repoPath, name)));
}

// Pick what to cruise: an explicit subfolder scope wins; else a conventional source dir; else the repo.
function resolveTarget(repoPath, scope) {
  if (scope) return scope;
  for (const dir of ["src", "lib", "app"]) {
    if (existsSync(join(repoPath, dir))) return dir;
  }
  return ".";
}

export async function runDepCruiseOnRepo(repoPath, { scope = "" } = {}) {
  if (!existsSync(repoPath)) return { ok: false, error: "Repo path not found" };
  if (!existsSync(join(repoPath, "package.json"))) {
    return { ok: false, skipped: true, error: "No package.json — dependency-cruiser needs a JS/TS project" };
  }
  const usedConfig = repoHasOwnConfig(repoPath) ? "repo" : "default";
  const target = resolveTarget(repoPath, scope);
  // npx --package: the bin is `depcruise`, but `npx depcruise` resolves a malicious placeholder
  // package, so the real package name `dependency-cruiser` must be named explicitly.
  const args = ["-y", "--package", "dependency-cruiser", "depcruise", target, "--output-type", "err-long"];
  // Per-module scope: dependency-cruiser otherwise FOLLOWS imports out of the target folder and
  // reports cycles/orphans in other modules. --include-only keeps the analysis inside the module.
  if (scope) {
    const rx = `^${scope.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]]/g, "\\$&")}(/|$)`;
    args.push("--include-only", rx);
  }
  if (usedConfig === "default") args.push("--config", DEFAULT_CONFIG);
  try {
    const result = await runCommand("npx", args, { cwd: repoPath, timeoutMs: DEPCRUISE_TIMEOUT_MS });
    const output = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    return {
      ok: true,
      exitCode: result.exitCode,
      scope,
      target,
      usedConfig,
      topFolders: repoTopFolders(repoPath),
      output: output.slice(0, 20000) || "dependency-cruiser found no violations."
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
