// Repo filesystem scan for infrastructure detection: one walk collects manifest dependency tokens,
// container image refs, env-var KEY names (never values — see the privacy note in infra.js), and
// code files for the import-attribution pass. Split out of infra.js (which remains the public facade).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { safeRead } from "./infra-items.js";
import { depsFromManifest, normImageRepo } from "./infra.match.js";

// ---- scanning bounds (mirror apimap.js) ---------------------------------------------------------
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", "coverage", "vendor",
  ".venv", "venv", "env", "target", "__pycache__", ".idea", ".vscode", ".cache", "bin", "obj",
]);
const CODE_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".java", ".kt", ".rb", ".php", ".cs", ".scala", ".rs",
]);
const MAX_FILES = 60000;
// graph-analysis IPC stays responsive on large repos — detection itself (manifests/images/env) is unaffected

const MANIFEST_NAMES = new Set([
  "package.json", "composer.json", "go.mod", "go.sum", "requirements.txt", "constraints.txt",
  "pipfile", "pyproject.toml", "cargo.toml", "pom.xml", "packages.config", "gemfile",
]);
const isManifest = (name) => {
  const n = name.toLowerCase();
  return MANIFEST_NAMES.has(n) || n.endsWith(".gradle") || n.endsWith(".gradle.kts") || n.endsWith(".csproj") || n.endsWith(".fsproj");
};
const isComposeFile = (name) => /^(docker-)?compose([.-].*)?\.ya?ml$/i.test(name);
const isDockerfile = (name) => /^dockerfile(\..+)?$/i.test(name) || /\.dockerfile$/i.test(name);
const isYaml = (name) => /\.ya?ml$/i.test(name);

// ---- the scan -----------------------------------------------------------------------------------
export function scanRepo(repoPath) {
  const deps = new Set();         // manifest dependency tokens
  const imageRefs = [];           // normalized image repo paths
  const envKeys = new Set();      // UPPERCASE env-var names (keys only)
  const codeFiles = [];           // { path(rel, fwd-slash), full } for the import pass
  const manifests = new Set();    // which manifest kinds were seen (for diagnostics)

  let count = 0;
  const stack = [repoPath];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(cur, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (++count > MAX_FILES) break;
      const name = entry.name;
      const full = join(cur, name);
      const rel = full.slice(repoPath.length).replace(/^[\\/]/, "").replace(/\\/g, "/");

      if (isManifest(name)) {
        manifests.add(name.toLowerCase());
        for (const d of depsFromManifest(name, safeRead(full))) deps.add(d);
        continue;
      }
      if (/^\.env(\..+)?$/i.test(name)) {
        const text = safeRead(full);
        // KEYS ONLY — split on the first '=' and keep the left side; never read the value.
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          if (m) envKeys.add(m[1].toUpperCase());
        }
        continue;
      }
      const dockery = isComposeFile(name) || isDockerfile(name);
      if (dockery || isYaml(name)) {
        const text = safeRead(full);
        if (!text) continue;
        const k8sLike = /(^|\n)\s*kind:\s*\S/.test(text) && /(^|\n)\s*(image|env):/.test(text);
        if (!dockery && !k8sLike) continue; // a random *.yaml that isn't a manifest — skip
        for (const m of text.matchAll(/(?:^|\n)\s*(?:-\s*)?image:\s*["']?([^\s"']+)/gi)) imageRefs.push(normImageRepo(m[1]));
        for (const m of text.matchAll(/(?:^|\n)\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)/gi)) imageRefs.push(normImageRepo(m[1]));
        // env var NAMES: k8s `- name: KEY`, compose `KEY: value` / `- KEY=value`, Dockerfile `ENV KEY`
        for (const m of text.matchAll(/\bname:\s*["']?([A-Z_][A-Z0-9_]{2,})\b/g)) envKeys.add(m[1].toUpperCase());
        for (const m of text.matchAll(/(?:^|\n)\s*(?:-\s*)?([A-Z_][A-Z0-9_]{2,})\s*[:=]/g)) envKeys.add(m[1].toUpperCase());
        continue;
      }
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
      if (CODE_EXT.has(ext)) codeFiles.push({ path: rel, full });
    }
    if (count > MAX_FILES) break;
  }
  const imageSegs = imageRefs.filter(Boolean).map((r) => ({ raw: r, segs: r.split("/").filter(Boolean) }));
  return { deps, imageSegs, envKeys, codeFiles, manifests: [...manifests] };
}
