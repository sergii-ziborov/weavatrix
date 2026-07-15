import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function isPathInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Cache the canonical root for callers that resolve many graph-derived paths.
export function createRepoBoundary(repoRoot) {
  let root;
  let rootError;
  try {
    root = realpathSync.native(repoRoot);
  } catch (error) {
    rootError = error;
  }

  return {
    root,
    resolve(candidate) {
      if (!root) return { ok: false, reason: "invalid-root", error: rootError };
      const input = String(candidate ?? "");
      if (!input || input.includes("\0")) return { ok: false, reason: "invalid-path" };
      if (isAbsolute(input)) return { ok: false, reason: "escape" };

      let lexical;
      try {
        lexical = resolve(root, input);
      } catch (error) {
        return { ok: false, reason: "invalid-path", error };
      }
      if (!isPathInside(root, lexical)) return { ok: false, reason: "escape" };

      let target;
      try {
        target = realpathSync.native(lexical);
      } catch (error) {
        return { ok: false, reason: error?.code === "ENOENT" ? "not-found" : "unreadable", error };
      }
      if (!isPathInside(root, target)) return { ok: false, reason: "escape" };

      return { ok: true, path: target };
    },
  };
}

// Resolve one existing repo-relative path without allowing lexical traversal or
// symlink/junction escapes. Callers get a reason instead of an exception so MCP
// tools can refuse the read without exposing host filesystem details.
export function resolveRepoPath(repoRoot, candidate) {
  return createRepoBoundary(repoRoot).resolve(candidate);
}
