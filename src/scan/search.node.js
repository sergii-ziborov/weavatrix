// Dependency-free Node fs-walk search engine for the cross-repo search, plus the shared SKIP_DIRS
// list. Split out of search.js.
import { statSync } from "node:fs";
import { readFile, opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { repoBaseName } from "./discover.js";

export const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".cache", ".turbo", "vendor", "__pycache__", ".venv"]);

// ---- Node fs-walk fallback (no ripgrep) ---------------------------------------------------------
export async function nodeSearch(roots, query, mode, cap) {
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
