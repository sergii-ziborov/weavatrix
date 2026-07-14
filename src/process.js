// Resolving and running the Claude/Codex CLIs, plus tool subprocesses. Node port of the original
// Bun version: Bun.spawn -> child_process.spawn, Bun.env -> process.env.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_MODEL, CLAUDE_MODELS, CODEX_MODELS } from "./config.js";
import { unique, stripQuotes, fileExists, pathExists } from "./util.js";

export function resolveClaudeModel(model) {
  const normalized = String(model || "").trim().toLowerCase();
  return CLAUDE_MODELS.includes(normalized) ? normalized : CLAUDE_MODEL;
}

export function resolveCodexModel(model) {
  const value = String(model || "").trim();
  return CODEX_MODELS.includes(value) ? value : "";
}

// Windows: .cmd/.ps1 shims (claude.cmd, npx, etc.) can't be spawned directly by Node — they need a
// shell. With shell:true Node does NOT quote args, so we build a quoted command line ourselves
// (repo paths contain spaces). POSIX uses the normal argv array, no shell.
export function winQuote(value) {
  const s = String(value);
  return /[\s&()[\]{}^=;!'+,`~|<>"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function runCommand(command, args = [], options = {}) {
  // Windows: .cmd/.ps1/bare-name shims (claude.cmd, npx, …) need a cmd.exe shell. But a real .exe
  // (codex.exe, where.exe) must be spawned DIRECTLY — wrapping an .exe in the shell breaks stdin
  // piping (codex reads its prompt from stdin via `-`), which surfaced as "Codex returned no output".
  const needsShell = process.platform === "win32" && !/\.exe$/i.test(command);
  return new Promise((resolve, reject) => {
    const child = needsShell
      ? spawn([command, ...args].map(winQuote).join(" "), [], {
          cwd: options.cwd || undefined,
          env: { ...process.env, ...(options.env || {}) },
          shell: true,
          windowsHide: true
        })
      : spawn(command, args, {
          cwd: options.cwd || undefined,
          env: { ...process.env, ...(options.env || {}) },
          windowsHide: true
        });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let hardTimer = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      fn();
    };
    // On timeout, kill the WHOLE process tree. With shell:true the child is cmd.exe; child.kill() would only
    // kill the shell, leaving npx→node→knip running and the stdio pipes open → 'close' never fires → the IPC
    // hangs forever (the "Running knip…" toast never clears). taskkill /T kills the tree; SIGKILL group on POSIX.
    const killTree = () => {
      if (process.platform === "win32" && child.pid) {
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } catch {
          try { child.kill(); } catch { /* process may already be gone */ }
        }
      } else {
        try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
      }
      // hard fallback: if 'close' still never fires after the kill, settle anyway so the caller can't hang
      hardTimer = setTimeout(() => finish(() => reject(new Error("Command timed out"))), 4000);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, options.timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    if (options.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => (timedOut ? reject(new Error("Command timed out")) : resolve({ stdout, stderr, exitCode: code }))));
  });
}

async function npmPrefixCandidates() {
  const appData = process.env.APPDATA || "";
  const prefixes = [appData ? `${appData}\\npm` : "", process.env.NPM_CONFIG_PREFIX && stripQuotes(process.env.NPM_CONFIG_PREFIX)];
  try {
    const result = await runCommand("npm", ["config", "get", "prefix"], { timeoutMs: 5000 });
    const prefix = stripQuotes(String(result.stdout || "").trim());
    if (prefix && prefix !== "undefined" && prefix !== "null") prefixes.push(prefix);
  } catch {
    // npm is optional for the status endpoint; PATH and explicit CLAUDE_CODE_CMD still work.
  }
  return unique(prefixes.filter(Boolean));
}

// Resolve a CLI's real location via Windows `where` — handles npm-global / nvm-managed shims the
// hardcoded candidate list can't predict. Returns only spawnable .cmd/.exe/.bat paths (not .ps1).
async function whereCandidates(name) {
  try {
    const result = await runCommand("where.exe", [name], { timeoutMs: 5000 });
    return String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /\.(cmd|exe|bat)$/i.test(line));
  } catch {
    return [];
  }
}

async function claudeCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const scoop = home ? `${home}\\scoop` : "";
  const npmPrefixes = await npmPrefixCandidates();
  // Concrete .cmd/.exe paths FIRST; bare "claude" LAST (a bare name gets shell-wrapped on Windows).
  return unique([
    process.env.CLAUDE_CODE_CMD && stripQuotes(process.env.CLAUDE_CODE_CMD),
    ...(await whereCandidates("claude")),
    ...npmPrefixes.flatMap((prefix) => [`${prefix}\\claude.cmd`, `${prefix}\\claude.ps1`]),
    scoop && `${scoop}\\shims\\claude.cmd`,
    scoop && `${scoop}\\shims\\claude.ps1`,
    scoop && `${scoop}\\apps\\claude-code\\current\\claude.cmd`,
    scoop && `${scoop}\\apps\\claude-code\\current\\bin\\claude.cmd`,
    localAppData && `${localAppData}\\Programs\\claude\\claude.exe`,
    localAppData && `${localAppData}\\Claude\\claude.exe`,
    "claude"
  ]);
}

function codexExtensionCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const extensionRoot = home ? `${home}\\.vscode\\extensions` : "";
  if (!extensionRoot || !existsSync(extensionRoot)) return [];
  try {
    return readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^openai\.chatgpt-/i.test(entry.name))
      .map((entry) => join(extensionRoot, entry.name, "bin", "windows-x86_64", "codex.exe"));
  } catch {
    return [];
  }
}

async function codexCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appData = process.env.APPDATA || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const npmPrefixes = await npmPrefixCandidates();
  // Concrete .exe/.cmd paths FIRST; bare "codex" LAST. A bare name gets shell-wrapped on Windows
  // (breaks stdin) and the lax availability check can falsely pick it, so prefer a real binary.
  return unique([
    process.env.CODEX_CLI_CMD && stripQuotes(process.env.CODEX_CLI_CMD),
    ...(await whereCandidates("codex")),
    ...codexExtensionCandidates(),
    ...npmPrefixes.flatMap((prefix) => [`${prefix}\\codex.cmd`, `${prefix}\\codex.exe`, `${prefix}\\codex.ps1`]),
    appData && `${appData}\\npm\\codex.cmd`,
    home && `${home}\\.codex\\bin\\codex.exe`,
    localAppData && `${localAppData}\\Programs\\Codex\\codex.exe`,
    appData && `${appData}\\npm\\codex.ps1`,
    "codex"
  ]);
}

async function resolveClaudeCommand() {
  const candidates = await claudeCandidates();
  const attempts = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate !== "claude" && !(await fileExists(candidate))) {
      attempts.push({ candidate, skipped: "not found" });
      continue;
    }
    try {
      const result = await runCommand(candidate, ["--version"], { timeoutMs: 10000 });
      if (result.exitCode === 0 || result.stdout || result.stderr) {
        return { available: true, command: candidate, version: `${result.stdout || result.stderr}`.trim(), attempts };
      }
      attempts.push({ candidate, exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) });
    } catch (error) {
      attempts.push({ candidate, error: error.message });
    }
  }
  return {
    available: false,
    reason: "Claude Code CLI was not found. Set CLAUDE_CODE_CMD or install claude in PATH.",
    attempts
  };
}

let claudeStatusCache = null;
let claudeStatusCacheAt = 0;
let codexStatusCache = null;
let codexStatusCacheAt = 0;

export async function getClaudeStatus(force = false) {
  if (!force && claudeStatusCache && Date.now() - claudeStatusCacheAt < 30000) return claudeStatusCache;
  claudeStatusCache = await resolveClaudeCommand();
  claudeStatusCacheAt = Date.now();
  return claudeStatusCache;
}

async function resolveCodexCommand() {
  const candidates = await codexCandidates();
  const attempts = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate !== "codex" && !(await pathExists(candidate))) {
      attempts.push({ candidate, skipped: "not found" });
      continue;
    }
    try {
      const result = await runCommand(candidate, ["--version"], { timeoutMs: 10000 });
      if (result.exitCode === 0 || result.stdout || result.stderr) {
        return { available: true, command: candidate, version: `${result.stdout || result.stderr}`.trim(), attempts };
      }
      attempts.push({ candidate, exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) });
    } catch (error) {
      attempts.push({ candidate, error: error.message });
    }
  }
  return { available: false, reason: "Codex CLI was not found. Set CODEX_CLI_CMD or install/open Codex CLI in PATH.", attempts };
}

export async function getCodexStatus(force = false) {
  if (!force && codexStatusCache && Date.now() - codexStatusCacheAt < 30000) return codexStatusCache;
  codexStatusCache = await resolveCodexCommand();
  codexStatusCacheAt = Date.now();
  return codexStatusCache;
}
