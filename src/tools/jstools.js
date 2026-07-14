// JS/TS dead-code & dependency tools run via npx (no install into the repo): knip + depcheck.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KNIP_TIMEOUT_MS, JS_TOOL_CMD } from "../config.js";
import { runCommand } from "../process.js";
import { summarizeWithClaude } from "../engine.js";

export async function runKnipOnRepo(repoPath, withSummary, model) {
  if (!existsSync(repoPath)) return { ok: false, error: "Repo path not found" };
  if (!existsSync(join(repoPath, "package.json"))) {
    return { ok: false, skipped: true, error: "No package.json — knip needs a JS/TS project" };
  }
  try {
    const result = await runCommand("npx", ["-y", "knip", "--no-progress"], {
      cwd: repoPath,
      timeoutMs: KNIP_TIMEOUT_MS
    });
    const output = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    const summary = withSummary
      ? await summarizeWithClaude(
          "Summarize this knip dead-code/unused-deps report in 4-7 concise bullets: unused files, unused dependencies, unused exports worth removing, and what to prioritize. If the report shows no issues, say so.",
          output,
          model
        )
      : "";
    return { ok: true, exitCode: result.exitCode, output: output.slice(0, 20000) || "knip found no issues.", summary };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function runJsTool(repoPath, tool, model) {
  if (!existsSync(repoPath)) return { ok: false, error: "Repo path not found" };
  if (!existsSync(join(repoPath, "package.json"))) {
    return { ok: false, skipped: true, error: "Needs a JS/TS project (no package.json)" };
  }
  const spec = JS_TOOL_CMD[tool];
  if (!spec) return { ok: false, error: `Unknown tool: ${tool}` };
  try {
    const result = await runCommand("npx", ["-y", ...spec], { cwd: repoPath, timeoutMs: KNIP_TIMEOUT_MS });
    const output = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    return { ok: true, exitCode: result.exitCode, output: output.slice(0, 20000) || `${tool} found no issues.` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
