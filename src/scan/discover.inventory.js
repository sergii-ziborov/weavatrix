// Filesystem inventory helpers for repo discovery: size proxy, file/extension census, last commit.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Directories never worth walking when sizing a repo (vendored deps, build output, caches).
const SIZE_SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", "coverage", "vendor",
  ".venv", "venv", "env", "target", "__pycache__", ".idea", ".vscode", ".cache", "bin", "obj"
]);

// Cheap "size" proxy: count source files in the working tree (skipping the heavy dirs above).
// Bounded so a pathological tree can't stall the scan.
export function repoFileCount(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SIZE_SKIP_DIRS.has(entry.name)) stack.push(join(cur, entry.name));
      } else if (entry.isFile()) {
        if (++count >= 100000) return count;
      }
    }
  }
  return count;
}

export function repoInventory(dir) {
  let count = 0;
  const ext = {};
  const files = new Set();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SIZE_SKIP_DIRS.has(entry.name)) stack.push(join(cur, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (++count >= 100000) return { count, ext, files };
      const full = join(cur, entry.name);
      const rel = full.slice(dir.length).replace(/^[\\/]/, "").replace(/\\/g, "/").toLowerCase();
      files.add(rel);
      const m = entry.name.toLowerCase().match(/(\.[a-z0-9]+)$/);
      if (m) ext[m[1]] = (ext[m[1]] || 0) + 1;
    }
  }
  return { count, ext, files };
}

// Last commit time (ms) read straight from .git/logs/HEAD — no `git` spawn. Each reflog line is
// "<old> <new> <Name> <email> <unixtime> <tz>\t<message>"; the unixtime is the token before the tz.
export function repoLastCommit(dir) {
  try {
    const log = readFileSync(join(dir, ".git", "logs", "HEAD"), "utf8").trimEnd();
    if (!log) return 0;
    const lastLine = log.slice(log.lastIndexOf("\n") + 1).split("\t")[0];
    const tokens = lastLine.trim().split(/\s+/);
    const unixTime = Number(tokens[tokens.length - 2]);
    return Number.isFinite(unixTime) ? unixTime * 1000 : 0;
  } catch {
    return 0;
  }
}
