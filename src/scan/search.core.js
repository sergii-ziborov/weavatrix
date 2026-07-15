// Orchestrator for the cross-repo search: picks ripgrep → git grep → pure-Node engine per the
// configured engine and delegates to the matching module. Split out of search.js.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRg, rgSearch } from "./search.rg.js";
import { gitSearch } from "./search.git.js";
import { nodeSearch } from "./search.node.js";

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
