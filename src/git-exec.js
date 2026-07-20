// The single chokepoint for launching git. Every git subprocess in the package routes through here,
// so there is one place that applies `-C <repoRoot>` containment, a credential-stripped child
// environment, a hidden Windows window and a bounded timeout — instead of a dozen near-identical
// spawnSync wrappers scattered across the analysis, graph and MCP layers.
import { spawnSync, spawn } from "node:child_process";
import { childProcessEnv } from "./child-env.js";

// Synchronous git. Returns the raw spawnSync result ({status, stdout, stderr, error}) so callers keep
// their existing status/stdout/error handling. encoding defaults to "utf8" (pass "buffer" for binary
// stdout); maxBuffer and stdio are forwarded only when provided so Node's defaults are preserved.
export function runGit(repoRoot, args, options = {}) {
  const spawnOptions = {
    encoding: options.encoding ?? "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 8000,
    env: childProcessEnv(options.env),
  };
  if (options.maxBuffer != null) spawnOptions.maxBuffer = options.maxBuffer;
  if (options.stdio != null) spawnOptions.stdio = options.stdio;
  return spawnSync("git", ["-C", repoRoot, ...args], spawnOptions);
}

// Streaming git for the history collector: byte-bounded stdout, a hard timeout that SIGKILLs the child,
// and a resolved {stdout, stderr, exitCode, truncated}. The caller owns cwd/env so reads can be scoped
// to a specific worktree.
export function boundedGitCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [], stderr = [];
    let stdoutBytes = 0, stderrBytes = 0, truncated = false, timedOut = false, settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const stop = () => { try { child.kill("SIGKILL"); } catch { /* process already exited */ } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (truncated) return;
      const remaining = options.maxOutputBytes - stdoutBytes;
      if (remaining <= 0) { truncated = true; stop(); return; }
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stdout.push(kept); stdoutBytes += kept.length;
      if (kept.length !== chunk.length) { truncated = true; stop(); }
    });
    child.stderr?.on("data", (chunk) => {
      const remaining = 64 * 1024 - stderrBytes;
      if (remaining <= 0) return;
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stderr.push(kept); stderrBytes += kept.length;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) => finish(() => {
      if (timedOut) return reject(new Error("git history collection timed out"));
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: Number(exitCode ?? 1),
        truncated,
      });
    }));
  });
}
