// Subprocess runner shared by the search engines and security sweeps.
import { spawn, spawnSync } from "node:child_process";
import { childProcessEnv } from "./child-env.js";

// Windows: .cmd/.ps1 shims (npx, etc.) can't be spawned directly by Node — they need a
// shell. With shell:true Node does NOT quote args, so we build a quoted command line ourselves
// (repo paths contain spaces). POSIX uses the normal argv array, no shell.
export function winQuote(value) {
  const s = String(value);
  return /[\s&()[\]{}^=;!'+,`~|<>"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function runCommand(command, args = [], options = {}) {
  // Windows: .cmd/.ps1/bare-name shims (npx, …) need a cmd.exe shell. But a real .exe
  // (rg.exe, where.exe) must be spawned DIRECTLY — wrapping an .exe in the shell breaks stdin
  // piping, which surfaced as "command returned no output".
  const needsShell = process.platform === "win32" && !/\.exe$/i.test(command);
  return new Promise((resolve, reject) => {
    const child = needsShell
      ? spawn([command, ...args].map(winQuote).join(" "), [], {
          cwd: options.cwd || undefined,
          env: childProcessEnv(options.env || {}),
          shell: true,
          windowsHide: true
        })
      : spawn(command, args, {
          cwd: options.cwd || undefined,
          env: childProcessEnv(options.env || {}),
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
    // kill the shell, leaving npx→node→tool running and the stdio pipes open → 'close' never fires → the
    // caller hangs forever. taskkill /T kills the tree; SIGKILL group on POSIX.
    const killTree = () => {
      if (process.platform === "win32" && child.pid) {
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, env: childProcessEnv() });
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

// Synchronous run-and-collect variant for callers that resolve a real binary and read its output in
// one shot (ripgrep resolution/search, tar extraction). These launch a resolved .exe or bare binary
// directly, so no shell quoting is needed; the child env is stripped of connector secrets and a
// bounded timeout/buffer applies. Returns the raw spawnSync result ({status, stdout, stderr, error}).
export function runCommandSync(command, args = [], options = {}) {
  const spawnOptions = {
    cwd: options.cwd || undefined,
    encoding: options.encoding ?? "utf8",
    env: childProcessEnv(options.env),
    windowsHide: true,
  };
  if (options.timeout != null) spawnOptions.timeout = options.timeout;
  if (options.maxBuffer != null) spawnOptions.maxBuffer = options.maxBuffer;
  if (options.stdio != null) spawnOptions.stdio = options.stdio;
  return spawnSync(command, args, spawnOptions);
}
