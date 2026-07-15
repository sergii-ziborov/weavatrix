// ripgrep engine for the cross-repo search: resolve a usable rg binary (bundled / VS Code / Cursor /
// PATH) and run the ripgrep-backed filename + content search. Split out of search.js.
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { runCommand } from "../process.js";
import { repoBaseName } from "./discover.js";

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
export async function rgSearch(rg, roots, query, mode, cap) {
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
