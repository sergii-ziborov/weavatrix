// Shared fs/text helpers.
import { readFileSync, statSync } from "node:fs";

// Bounded, never-throwing file read shared by the source scanners (infra, endpoints): oversized
// files are skipped, not truncated — a partial read would produce misleading matches.
export const MAX_FILE_BYTES = 512 * 1024;

// Order-preserving dedupe by a derived key — first occurrence wins.
export function uniqueBy(list, keyFn) {
  const seen = new Set();
  return list.filter((item) => {
    const k = keyFn(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function lineNumberAt(text, index) {
  let line = 1;
  for (let offset = 0; offset < index && offset < text.length; offset++) {
    if (text[offset] === "\n") line++;
  }
  return line;
}

export function safeRead(path) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
