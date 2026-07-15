// In-app search preview file access: read/write a file's text ONLY if it sits under one of the
// known repo roots. Split out of search.js.
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

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
