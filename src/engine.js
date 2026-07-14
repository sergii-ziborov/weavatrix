// One-shot completions on the chosen engine (claude OR codex). Used by repo analysis,
// the generic /api/engine/analyze endpoint, and knip summaries.
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_TIMEOUT_MS, CODEX_TIMEOUT_MS, ROOT_DIR } from "./config.js";
import { getClaudeStatus, getCodexStatus, resolveClaudeModel, resolveCodexModel, runCommand } from "./process.js";

export async function summarizeWithClaude(instruction, text, model) {
  const status = await getClaudeStatus();
  if (!status.available || !text) return "";
  try {
    const args = ["-p"];
    const chosen = resolveClaudeModel(model);
    if (chosen) args.push("--model", chosen);
    const result = await runCommand(status.command, args, {
      stdin: `${instruction}\n\n${String(text).slice(0, 14000)}`,
      timeoutMs: CLAUDE_TIMEOUT_MS
    });
    return `${result.stdout || ""}`.trim().slice(0, 4000);
  } catch {
    return "";
  }
}

// Run a one-shot completion on the chosen engine (claude OR codex). cwd lets the engine read a repo.
export async function runEngineCompletion({ engine, model, prompt, cwd, timeoutMs }) {
  if (engine === "codex") {
    const status = await getCodexStatus();
    if (!status.available) return { ok: false, error: "Codex CLI not available" };
    const ms = timeoutMs || CODEX_TIMEOUT_MS;
    const tempDir = mkdtempSync(join(tmpdir(), "weavatrix-codex-an-"));
    const outputPath = join(tempDir, "out.txt");
    try {
      const chosenCodex = resolveCodexModel(model);
      const result = await runCommand(
        status.command,
        [...(chosenCodex ? ["-m", chosenCodex] : []), "-a", "never", "-C", cwd || ROOT_DIR, "-s", "read-only", "exec", "--skip-git-repo-check", "--output-last-message", outputPath, "-"],
        { stdin: prompt, timeoutMs: ms }
      );
      const text = ((existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "") || result.stdout || "").trim();
      return text ? { ok: true, text: text.slice(0, 8000) } : { ok: false, error: "Codex returned no output" };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  const status = await getClaudeStatus();
  if (!status.available) return { ok: false, error: "Claude Code CLI not available" };
  const ms = timeoutMs || CLAUDE_TIMEOUT_MS;
  const args = ["-p"];
  const chosen = resolveClaudeModel(model);
  if (chosen) args.push("--model", chosen);
  const result = await runCommand(status.command, args, { cwd, stdin: prompt, timeoutMs: ms });
  const text = `${result.stdout || result.stderr || ""}`.trim();
  return text ? { ok: true, text: text.slice(0, 8000) } : { ok: false, error: "No output" };
}
