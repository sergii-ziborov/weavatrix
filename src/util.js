// Generic helpers (Node). Trimmed for weavatrix — only what process.js / graph-builder need.
import { existsSync } from "node:fs";

export function unique(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

export async function fileExists(path) {
  try {
    return Boolean(path && existsSync(path));
  } catch {
    return false;
  }
}

export async function pathExists(path) {
  try {
    return Boolean(path && existsSync(path));
  } catch {
    return false;
  }
}

export function stripQuotes(value = "") {
  return String(value).trim().replace(/^["']|["']$/g, "");
}
