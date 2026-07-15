// git grep / git ls-files engine for the cross-repo search — the fast native fallback when no
// ripgrep can be resolved (falls back to the pure-Node scanner per repo). Split out of search.js.
import { join } from "node:path";
import { runCommand } from "../process.js";
import { repoBaseName } from "./discover.js";
import { SKIP_DIRS, nodeSearch } from "./search.node.js";

// ---- git grep native fallback ------------------------------------------------------------------
const GIT_PATHSPECS = [
  ".",
  ...[...SKIP_DIRS].map((dir) => `:(exclude)${dir}/**`)
];

function gitArgs(root, subcommand, args) {
  return ["-C", root, "-c", "core.quotePath=false", subcommand, ...args];
}

function parseGitGrepLine(line) {
  const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  return {
    relPath: m[1],
    line: Number(m[2]) || 0,
    column: Math.max(0, (Number(m[3]) || 1) - 1),
    preview: m[4]
  };
}

function pathHasSkippedDir(relPath) {
  return String(relPath || "")
    .split(/[\\/]+/)
    .some((part) => SKIP_DIRS.has(part));
}

async function gitSearchRoot(git, root, query, mode, cap) {
  if (mode === "filename") {
    const r = await runCommand(git, gitArgs(root, "ls-files", ["-z", "--cached", "--others", "--exclude-standard", "--", ...GIT_PATHSPECS]), { timeoutMs: 15000 });
    if (r.exitCode !== 0) return { ok: false, error: (r.stderr || r.stdout || "git ls-files failed").slice(0, 300) };
    const lower = query.toLowerCase();
    const ci = query === lower;
    const hitIdx = (s) => (ci ? s.toLowerCase().indexOf(lower) : s.indexOf(query));
    const files = String(r.stdout || "").split("\0").filter(Boolean);
    const results = [];
    for (const relPath of files) {
      if (results.length >= cap) break;
      if (pathHasSkippedDir(relPath)) continue;
      const idx = hitIdx(relPath);
      if (idx >= 0) results.push({ repo: repoBaseName(root), path: join(root, relPath), line: 0, column: idx, preview: relPath.replace(/\\/g, "/") });
    }
    return { ok: true, truncated: files.length > results.length && results.length >= cap, results };
  }

  const r = await runCommand(
    git,
    gitArgs(root, "grep", ["-n", "--column", "-I", "--untracked", "-F", "-e", query, "--", ...GIT_PATHSPECS]),
    { timeoutMs: 20000 }
  );
  if (r.exitCode !== 0 && r.exitCode !== 1) return { ok: false, error: (r.stderr || r.stdout || "git grep failed").slice(0, 300) };
  const lines = String(r.stdout || "").split(/\r?\n/).filter(Boolean);
  const results = [];
  for (const line of lines) {
    if (results.length >= cap) break;
    const parsed = parseGitGrepLine(line);
    if (!parsed || pathHasSkippedDir(parsed.relPath)) continue;
    results.push({
      repo: repoBaseName(root),
      path: join(root, parsed.relPath),
      line: parsed.line,
      column: parsed.column,
      preview: parsed.preview.slice(0, 400)
    });
  }
  return { ok: true, truncated: lines.length > results.length && results.length >= cap, results };
}

export async function gitSearch(git, roots, query, mode, cap) {
  const results = [];
  let truncated = false;
  let usedNodeFallback = false;
  for (const root of roots) {
    if (results.length >= cap) {
      truncated = true;
      break;
    }
    let r;
    try {
      r = await gitSearchRoot(git, root, query, mode, cap - results.length);
    } catch {
      r = { ok: false };
    }
    if (!r.ok) {
      usedNodeFallback = true;
      const fallback = await nodeSearch([root], query, mode, cap - results.length);
      results.push(...fallback.results);
      truncated ||= fallback.truncated;
      continue;
    }
    results.push(...r.results);
    truncated ||= r.truncated;
  }
  return { ok: true, engine: usedNodeFallback ? "git-grep+node-fallback" : "git-grep", truncated, results };
}
