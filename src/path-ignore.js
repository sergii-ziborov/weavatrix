// Repository-local exclusions shared by graph building, audits and clone scanning.
// `.weavatrixignore` follows the useful Gitignore subset: comments, *, **, ?, root-anchored
// patterns, directory suffixes and ordered ! re-includes. It never expands paths or reads outside root.
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { createRepoBoundary } from "./repo-path.js";

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globRegex(pattern) {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += escapeRegex(char);
  }
  return out;
}

export function parseWeavatrixIgnore(text) {
  const rules = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    line = line.replace(/\\/g, "/");
    const anchored = line.startsWith("/");
    const directory = line.endsWith("/");
    line = line.replace(/^\/+|\/+$/g, "");
    if (!line || line.split("/").some((part) => part === "..")) continue;
    const prefix = anchored ? "^" : "(?:^|/)";
    const suffix = directory ? "(?:/.*)?$" : "$";
    rules.push({ negated, regex: new RegExp(`${prefix}${globRegex(line)}${suffix}`) });
  }
  return rules;
}

export function loadWeavatrixIgnore(repoRoot) {
  try {
    const resolved = createRepoBoundary(repoRoot).resolve(".weavatrixignore");
    if (!resolved.ok) return [];
    return parseWeavatrixIgnore(readFileSync(resolved.path, "utf8"));
  }
  catch { return []; }
}

export function isWeavatrixIgnored(path, rules) {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
  let ignored = false;
  for (const rule of rules || []) if (rule.regex.test(normalized)) ignored = !rule.negated;
  return ignored;
}

export function filterWeavatrixIgnored(repoRoot, files) {
  const rules = loadWeavatrixIgnore(repoRoot);
  if (!rules.length) return files;
  return files.filter((file) => {
    const path = isAbsolute(file) ? relative(repoRoot, file) : file;
    return !isWeavatrixIgnored(path, rules);
  });
}
