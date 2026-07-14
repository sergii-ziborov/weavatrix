// Fast cross-repo search: file NAMES + TEXT inside files, across every open repo at once. Backed by
// ripgrep when one can be resolved (bundled / VS Code / Cursor / PATH), git grep as a fast native
// fallback, and finally a dependency-free Node fs-walk fallback. One reusable searchAcrossRepos() so
// a future MCP server can call the same code.
import { existsSync, statSync, readdirSync } from "node:fs";
import { readFile, writeFile, opendir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { runCommand } from "../process.js";
import { repoBaseName } from "./discover.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".cache", ".turbo", "vendor", "__pycache__", ".venv"]);

// ---- ripgrep resolution (no bare `rg` — a packaged app's PATH usually lacks it) -----------------
function rgInInstall(base) {
  return [
    join(base, "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
    join(base, "resources", "app", "node_modules", "@vscode", "ripgrep-universal", "bin", "win32-x64", "rg.exe")
  ];
}
function editorRgCandidates() {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.PROGRAMFILES || "";
  const roots = [local && join(local, "Programs", "Microsoft VS Code"), local && join(local, "Programs", "cursor"), pf && join(pf, "Microsoft VS Code")].filter(Boolean);
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    out.push(...rgInInstall(root)); // non-versioned install
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) out.push(...rgInInstall(join(root, d.name))); // version-hashed dir
    } catch {
      /* ignore */
    }
  }
  return out;
}
function extensionRgCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const roots = [".vscode", ".vscode-insiders", ".cursor"].map((d) => home && join(home, d, "extensions")).filter(Boolean);
  const out = [];
  const walk = (dir, depth = 0) => {
    if (!dir || depth > 5 || out.length >= 20 || !existsSync(dir)) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= 20) break;
      const full = join(dir, ent.name);
      if (ent.isFile() && /^rg(\.exe)?$/i.test(ent.name)) out.push(full);
      else if (ent.isDirectory()) walk(full, depth + 1);
    }
  };
  for (const root of roots) walk(root);
  return out;
}
async function whereRg() {
  if (process.platform !== "win32") return [];
  try {
    const r = await runCommand("where.exe", ["rg"], { timeoutMs: 4000 });
    return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.exe$/i.test(l));
  } catch {
    return [];
  }
}
// engine (settings.searchEngine): "auto" (default — custom path → env → editor-bundled rg → PATH →
// git grep → Node), "system" (ONLY the system-installed rg from PATH, then Node), "git" (git grep /
// git ls-files, then Node), "node" (skip native tools entirely, pure-Node scanner).
const _rgCache = new Map(); // engine|rgPath -> { info, at }
// exported: the malware scanner (security/malware-heuristics.js) reuses the same rg resolution
export async function resolveRgInfo(engine = "auto", rgPath = "") {
  if (engine === "node" || engine === "git") return null;
  const key = `${engine}|${rgPath}`;
  const hit = _rgCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.info;
  const env = process.env.WEAVATRIX_RG_CMD && process.env.WEAVATRIX_RG_CMD.replace(/^"|"$/g, "");
  const pathCands = (await whereRg()).map((path) => ({ path, source: "PATH" }));
  const cands = [
    rgPath && { path: rgPath, source: "custom path" },
    engine === "auto" && env && { path: env, source: "WEAVATRIX_RG_CMD" },
    ...editorRgCandidates().map((path) => ({ path, source: "VS Code/Cursor bundle" })),
    ...extensionRgCandidates().map((path) => ({ path, source: "editor extension" })),
    ...pathCands,
    process.platform === "win32" ? null : { path: "rg", source: "PATH" },
  ].filter(Boolean);
  let info = null;
  for (const c of cands) {
    if (c.path === "rg" || existsSync(c.path)) {
      info = { path: c.path, source: c.source, detail: `${c.source}: ${c.path}` };
      break;
    }
  }
  _rgCache.set(key, { info, at: Date.now() });
  return info;
}

export async function resolveRg(engine = "auto", rgPath = "") {
  return (await resolveRgInfo(engine, rgPath))?.path || null;
}

function repoOfPath(roots, p) {
  const m = roots.find((r) => p === r || p.startsWith(r + sep) || p.startsWith(r + "/"));
  return m ? repoBaseName(m) : "";
}

// ---- ripgrep search -----------------------------------------------------------------------------
async function rgSearch(rg, roots, query, mode, cap) {
  if (mode === "filename") {
    const term = query.replace(/[[\]{}]/g, ""); // keep it a plain substring glob
    const args = ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", `*${term}*`, "--", ...roots];
    const r = await runCommand(rg, args, { timeoutMs: 15000 });
    if (r.exitCode === 2 && !r.stdout) return { ok: false, error: (r.stderr || "ripgrep error").slice(0, 300) };
    const lines = String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const results = [];
    for (const p of lines) {
      if (results.length >= cap) break;
      results.push({ repo: repoOfPath(roots, p), path: p, line: 0, column: 0, preview: p.split(/[\\/]/).pop() });
    }
    return { ok: true, engine: "ripgrep", truncated: lines.length > cap, results };
  }
  // content (literal/fixed-string smart-case)
  const args = ["--json", "-F", "--smart-case", "--max-count", "40", "--max-columns", "400", "--max-columns-preview", "--threads", "0", "-g", "!.git", "-g", "!node_modules", "-e", query, "--", ...roots];
  const r = await runCommand(rg, args, { timeoutMs: 20000 });
  if (r.exitCode === 2 && !r.stdout) return { ok: false, error: (r.stderr || "ripgrep error").slice(0, 300) };
  const results = [];
  let truncated = false;
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    if (!line) continue;
    if (results.length >= cap) {
      truncated = true;
      break;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "match") continue;
    const d = obj.data || {};
    const path = d.path?.text || "";
    if (!path) continue;
    const sub = (d.submatches || [])[0];
    results.push({
      repo: repoOfPath(roots, path),
      path,
      line: d.line_number || 0,
      column: sub ? sub.start : 0,
      preview: String(d.lines?.text || "").replace(/\r?\n$/, "").slice(0, 400)
    });
  }
  return { ok: true, engine: "ripgrep", truncated, results };
}

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

async function gitSearch(git, roots, query, mode, cap) {
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

// ---- Node fs-walk fallback (no ripgrep) ---------------------------------------------------------
async function nodeSearch(roots, query, mode, cap) {
  const isContent = mode !== "filename";
  const lower = query.toLowerCase();
  const ci = query === lower; // smart-case: case-insensitive unless the query has an uppercase letter
  const hit = (s) => (ci ? s.toLowerCase().includes(lower) : s.includes(query));
  const hitIdx = (s) => (ci ? s.toLowerCase().indexOf(lower) : s.indexOf(query));
  const results = [];
  let truncated = false;
  async function walk(dir, root) {
    if (results.length >= cap) {
      truncated = true;
      return;
    }
    let dh;
    try {
      dh = await opendir(dir);
    } catch {
      return;
    }
    for await (const ent of dh) {
      if (results.length >= cap) {
        truncated = true;
        break;
      }
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) await walk(full, root);
        continue;
      }
      if (!ent.isFile()) continue;
      const relPath = relative(root, full).replace(/\\/g, "/");
      if (!isContent) {
        const nameIdx = hitIdx(ent.name);
        const relIdx = hitIdx(relPath);
        if (nameIdx >= 0 || relIdx >= 0) results.push({ repo: repoBaseName(root), path: full, line: 0, column: Math.max(0, relIdx >= 0 ? relIdx : nameIdx), preview: relPath });
        continue;
      }
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > 1500000) continue;
      let buf;
      try {
        buf = await readFile(full);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue; // binary
      const linesArr = buf.toString("utf8").split(/\r?\n/);
      let fileHits = 0;
      for (let i = 0; i < linesArr.length; i++) {
        if (results.length >= cap) {
          truncated = true;
          break;
        }
        const idx = hitIdx(linesArr[i]);
        if (idx >= 0) {
          results.push({ repo: repoBaseName(root), path: full, line: i + 1, column: idx, preview: linesArr[i].slice(0, 400) });
          fileHits++;
          if (fileHits >= 40) break; // match rgSearch's --max-count 40 per file
        }
      }
    }
  }
  for (const root of roots) {
    if (results.length >= cap) break;
    await walk(root, root);
  }
  return { ok: true, engine: "node-fallback", truncated, results };
}

// repos: array of absolute repo paths; mode: "content" | "filename"; engine/rgPath: see resolveRg.
// Returns { ok, engine, truncated, results:[{repo, path, line, column, preview}] }.
export async function searchAcrossRepos({ repos, query, mode = "content", cap = 300, engine = "auto", rgPath = "", gitPath = "" } = {}) {
  const roots = [...new Set((Array.isArray(repos) ? repos : []).filter((p) => p && existsSync(p)).map((p) => resolve(p)))].sort((a, b) => b.length - a.length);
  const q = String(query || "");
  if (!roots.length || q.trim().length < 2) return { ok: true, engine: "none", truncated: false, results: [] };
  const rg = await resolveRg(engine, rgPath);
  const git = (engine === "auto" || engine === "git") ? String(gitPath || "").trim() || "git" : "";
  try {
    if (rg) return await rgSearch(rg, roots, q, mode, cap);
    if (git) return await gitSearch(git, roots, q, mode, cap);
    return await nodeSearch(roots, q, mode, cap);
  } catch (error) {
    return { ok: false, error: error.message, engine: rg ? "ripgrep" : git ? "git-grep" : "node-fallback", results: [] };
  }
}

// Resolve a preview/edit target ONLY if it sits UNDER one of the known repo roots — the shared guard
// for files:read and files:write. Returns { ok:true, path } or { ok:false, error }.
function resolveRepoFilePath(filePath, repos) {
  const roots = (Array.isArray(repos) ? repos : []).filter(Boolean).map((p) => resolve(p));
  const abs = resolve(String(filePath || ""));
  if (!abs || !roots.some((r) => abs === r || abs.startsWith(r + sep))) return { ok: false, error: "Path is outside the known repos" };
  if (!existsSync(abs)) return { ok: false, error: "File not found" };
  return { ok: true, path: abs };
}

// Read a file's text for the in-app preview — only if it sits UNDER one of the known repo roots.
export async function readFileForPreview(filePath, repos) {
  const resolved = resolveRepoFilePath(filePath, repos);
  if (resolved.ok === false) return resolved;
  const abs = resolved.path;
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, error: "Cannot stat file" };
  }
  if (st.size > 2000000) return { ok: false, error: "File too large to preview (>2 MB) — open it in VS Code." };
  try {
    return { ok: true, path: abs, content: await readFile(abs, "utf8") };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Write edited text back from the Search preview's Edit mode — same repo-root guard as the read, and
// only over files that already exist (the in-app editor touches up files, it never creates them).
export async function writeFileForPreview(filePath, repos, content) {
  const resolved = resolveRepoFilePath(filePath, repos);
  if (resolved.ok === false) return resolved;
  const text = String(content ?? "");
  if (text.length > 2000000) return { ok: false, error: "Edited text too large to save (>2 MB) — use VS Code." };
  try {
    await writeFile(resolved.path, text, "utf8");
    return { ok: true, path: resolved.path };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
