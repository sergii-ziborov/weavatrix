// Installed-package enumeration for supply-chain scanning: EXACT versions from lockfiles first
// (package-lock v1/v2/v3, basic yarn.lock, requirements.txt ==pins, go.sum), plus a top-level
// node_modules walk — which also yields the lockfile-DRIFT signal (installed ≠ locked → tampering or
// stale install). Parsers are pure + exported for tests; collectInstalled is the thin fs wrapper.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseGoMod } from "../analysis/manifests.js";
import { uniqueBy } from "../util.js";

const pep503 = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-"); // PyPI canonical name

const dedupe = (list) => uniqueBy(list, (p) => `${p.ecosystem}|${p.name}|${p.version}`);

export function parsePackageLock(json) {
  const out = [];
  const lockTracksScripts = Number(json?.lockfileVersion || 0) >= 2;
  if (json && json.packages && typeof json.packages === "object") { // v2/v3
    for (const [key, v] of Object.entries(json.packages)) {
      if (!key.startsWith("node_modules/") || !v || !v.version) continue;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length); // nested a/node_modules/b → b
      if (!name || name.startsWith(".")) continue;
      const depth = key.split("node_modules/").length - 1; // 1 = hoisted top-level, 2+ = nested duplicate
      out.push({ ecosystem: "npm", name, version: v.version, dev: !!v.dev, integrity: v.integrity || "", resolved: v.resolved || "", source: "package-lock", depth, hasInstallScript: lockTracksScripts ? !!v.hasInstallScript : undefined });
    }
  } else if (json && json.dependencies) { // v1 recursive tree
    const walk = (deps, depth) => {
      for (const [name, v] of Object.entries(deps || {})) {
        if (v && v.version) out.push({ ecosystem: "npm", name, version: v.version, dev: !!v.dev, integrity: v.integrity || "", source: "package-lock", depth });
        if (v && v.dependencies) walk(v.dependencies, depth + 1);
      }
    };
    walk(json.dependencies, 1);
  }
  return dedupe(out);
}

// yarn.lock selector → the REAL package name. Handles classic `name@range`, `@scope/name@range`, the
// `@npm:` protocol (`name@npm:range`), AND aliases (`react-is-18@npm:react-is@18.3.1` → react-is) —
// yarn installs aliased majors in `react-is-18/` dirs whose package.json name is still "react-is", so
// the lockfile must resolve to that real name or drift/vuln checks miss the aliased versions.
export function yarnSelectorName(sel) {
  const s = String(sel || "").trim().replace(/^"|"$/g, "");
  const npm = s.indexOf("@npm:");
  if (npm >= 0) {
    const after = s.slice(npm + 5); // text after "@npm:" — either "realname@range" (alias) or just "range"
    if (/^[a-z@]/i.test(after)) { // starts with a letter/scope → it's the real package name
      const at = after.startsWith("@") ? after.indexOf("@", 1) : after.indexOf("@");
      return at > 0 ? after.slice(0, at) : after;
    }
    return s.slice(0, npm); // "range" only → the real name is before @npm:
  }
  const at = s.lastIndexOf("@"); // classic name@range ; leading @ of a scope is index 0, ignored
  return at > 0 ? s.slice(0, at) : "";
}

// yarn.lock (classic v1 format): `"name@^1.0.0", "name@~1.2":\n  version "1.2.3"`
export function parseYarnLock(text) {
  const out = [];
  const re = /^((?:"[^\n]*")|(?:[^\s#"][^\n]*?)):\r?\n\s+version\s+"([^"]+)"/gm; // greedy quote span — selector lists like "a@^1", "a@~2": keep the full line
  for (const m of String(text || "").matchAll(re)) {
    const name = yarnSelectorName(m[1].split(",")[0]);
    if (name) out.push({ ecosystem: "npm", name, version: m[2], dev: false, integrity: "", source: "yarn-lock" });
  }
  return dedupe(out);
}

// requirements.txt: pins that carry a concrete version — exact `==`/`===` AND compatible-release `~=`
// (`~=1.26.8` floors at 1.26.8 within the 1.26.* series, a solid check target). Loose `>=`/`>`/`<`
// have no single version, so they're skipped (unknown-installed, not a false pin).
export function parseRequirements(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const m = line.match(/^([A-Za-z0-9][\w.-]*)\s*(===?|~=)\s*([\w.!+*-]+)/);
    if (m) out.push({ ecosystem: "PyPI", name: pep503(m[1]), version: String(m[3]).replace(/\.\*$/, ""), dev: false, integrity: "", source: "requirements" });
  }
  return dedupe(out);
}

// A repo's virtualenv site-packages *.dist-info = the ACTUALLY-installed Python versions (the PyPI
// equivalent of node_modules). Directory names are "<name>-<version>.dist-info". Windows Lib\ + posix lib\pythonX\.
export function collectVenvPackages(repoPath, { readdir = readdirSync } = {}) {
  const out = [];
  for (const venv of [".venv", "venv", "env"]) {
    const roots = [join(repoPath, venv, "Lib", "site-packages")]; // Windows layout
    try { for (const d of readdir(join(repoPath, venv, "lib"))) if (/^python/i.test(String(d))) roots.push(join(repoPath, venv, "lib", String(d), "site-packages")); } catch { /* posix layout absent */ }
    for (const sp of roots) {
      let entries;
      try { entries = readdir(sp); } catch { continue; }
      for (const e of entries) {
        const m = String(e).match(/^(.+?)-(\d[\w.!+-]*)\.dist-info$/);
        if (m) out.push({ ecosystem: "PyPI", name: pep503(m[1]), version: m[2], dev: false, integrity: "", source: "venv" });
      }
    }
  }
  return dedupe(out);
}

// poetry.lock / uv.lock — same TOML shape: [[package]] blocks with name/version lines
export function parseTomlLockPackages(text, source) {
  const out = [];
  let name = "", inPkg = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[\[package\]\]$/.test(line)) { inPkg = true; name = ""; continue; }
    if (/^\[/.test(line)) { inPkg = false; continue; } // any other table ends the package header block
    if (!inPkg) continue;
    let m = line.match(/^name\s*=\s*"([^"]+)"/);
    if (m) { name = m[1]; continue; }
    m = line.match(/^version\s*=\s*"([^"]+)"/);
    if (m && name) { out.push({ ecosystem: "PyPI", name: pep503(name), version: m[1], dev: false, integrity: "", source }); name = ""; }
  }
  return dedupe(out);
}

// Pipfile.lock: JSON { default: { name: {version:"==1.2.3"} }, develop: {…} }
export function parsePipfileLock(json) {
  const out = [];
  for (const [section, dev] of [["default", false], ["develop", true]]) {
    for (const [name, v] of Object.entries((json && json[section]) || {})) {
      const ver = String((v && v.version) || "").replace(/^==/, "");
      if (ver) out.push({ ecosystem: "PyPI", name: pep503(name), version: ver, dev, integrity: "", source: "pipfile-lock" });
    }
  }
  return dedupe(out);
}

// go.sum: "module v1.2.3 h1:hash" (skip /go.mod hash lines). OSV Go versions have no leading v.
export function parseGoSum(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = raw.trim().match(/^(\S+)\s+v([\w.+-]+?)(\/go\.mod)?\s+h1:/);
    if (m && !m[3]) out.push({ ecosystem: "Go", name: m[1], version: m[2], dev: false, integrity: "", source: "go-sum" });
  }
  return dedupe(out);
}

// go.mod require versions — the fallback when there is no go.sum (fresh checkout / `go mod download`
// not run). Pseudo-versions (v0.0.0-<ts>-<commit>) won't match OSV cleanly, but exact tags do; go.sum
// (when present) supersedes these via dedupe. Leading `v` stripped to match OSV's Go versions.
export function parseGoModPackages(text) {
  return dedupe(parseGoMod(text).requires.map((r) => ({ ecosystem: "Go", name: r.path, version: String(r.version).replace(/^v/, ""), dev: !!r.indirect, integrity: "", source: "go-mod" })));
}

// Top-level node_modules walk (incl. @scopes): the ground truth of what is REALLY on disk.
function walkNodeModules(repoPath) {
  const out = [];
  const nm = join(repoPath, "node_modules");
  const readPkg = (dir, name) => {
    try {
      const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pj && pj.version) out.push({ ecosystem: "npm", name: pj.name || name, version: pj.version, dev: false, integrity: "", source: "node_modules" });
    } catch { /* not a package dir */ }
  };
  let entries;
  try { entries = readdirSync(nm); } catch { return out; }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) {
      let scoped; try { scoped = readdirSync(join(nm, e)); } catch { continue; }
      for (const s of scoped) readPkg(join(nm, e, s), `${e}/${s}`);
    } else readPkg(join(nm, e), e);
  }
  return out;
}

const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

const SUBPROJECT_SKIP = new Set([".git", ".idea", ".vscode", ".venv", "venv", "env", "node_modules", "vendor", "dist", "build", "coverage", "__pycache__", ".tox", "testdata"]);

function projectDirs(repoPath) {
  const dirs = [repoPath];
  let entries = [];
  try { entries = readdirSync(repoPath, { withFileTypes: true }); } catch { return dirs; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SUBPROJECT_SKIP.has(e.name)) continue;
    dirs.push(join(repoPath, e.name));
    if (dirs.length >= 101) break;
  }
  return dirs;
}

function collectReqFiles(dir) {
  const reqFiles = [];
  try { for (const n of readdirSync(dir)) if (/^requirements[\w.-]*\.(txt|in)$/i.test(n)) reqFiles.push(join(dir, n)); } catch { /* unreadable root */ }
  try { for (const n of readdirSync(join(dir, "requirements"))) if (/\.(txt|in)$/i.test(n)) reqFiles.push(join(dir, "requirements", n)); } catch { /* no requirements/ dir */ }
  return reqFiles;
}

// → { installed: [{ecosystem,name,version,dev,source}], drift: [{name, locked, installed}] }
export function collectInstalled(repoPath) {
  const dirs = projectDirs(repoPath);
  const lock = [];
  const yarn = [];
  const disk = [];
  for (const dir of dirs) {
    const lockHere = parsePackageLock(readJson(join(dir, "package-lock.json")) || {});
    lock.push(...lockHere);
    if (!lockHere.length) yarn.push(...parseYarnLock(readText(join(dir, "yarn.lock")) || ""));
    disk.push(...walkNodeModules(dir));
  }
  // Python: venv site-packages = the ground truth (exact installed versions); requirements*.txt (root +
  // a requirements/ dir) and poetry/uv/Pipfile locks fill in when there's no venv. venv wins per name.
  const venvPy = dirs.flatMap((dir) => collectVenvPackages(dir));
  const reqFiles = dirs.flatMap((dir) => collectReqFiles(dir));
  const venvNames = new Set(venvPy.map((p) => p.name));
  const pyDeclared = [
    ...reqFiles.flatMap((f) => parseRequirements(readText(f) || "")),
    ...dirs.flatMap((dir) => parseTomlLockPackages(readText(join(dir, "poetry.lock")) || "", "poetry-lock")),
    ...dirs.flatMap((dir) => parseTomlLockPackages(readText(join(dir, "uv.lock")) || "", "uv-lock")),
    ...dirs.flatMap((dir) => parsePipfileLock(readJson(join(dir, "Pipfile.lock")) || null)),
  ].filter((p) => !venvNames.has(p.name)); // installed version supersedes the declared pin
  const py = [...venvPy, ...pyDeclared];
  // Go: go.sum (exact, hashed) first, then go.mod require versions as a fallback. Walk the repo root
  // AND its immediate subdirectories so a Go MONOREPO (per-folder modules, no root go.mod — e.g. gpro)
  // still scans; dedupe() collapses the go.sum/go.mod overlap and cross-module shared deps.
  const goFromDir = (dir) => [...parseGoSum(readText(join(dir, "go.sum")) || ""), ...parseGoModPackages(readText(join(dir, "go.mod")) || "")];
  const go = [...goFromDir(repoPath)];
  if (!go.length || existsSync(join(repoPath, "go.work"))) {
    let subs = [];
    try { subs = readdirSync(repoPath, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "vendor", "dist", "build", "testdata"].includes(e.name)); } catch { /* unreadable root */ }
    for (const s of subs.slice(0, 100)) go.push(...goFromDir(join(repoPath, s.name)));
  }

  // lockfile wins as the version source; disk fills gaps + powers the drift signal. A package
  // legitimately appears at SEVERAL versions in a lockfile (yarn/npm nest transitive duplicates), so
  // track the FULL SET of locked versions per name. "Drift" = the installed version matches NONE of
  // them — the old code compared against ONE arbitrarily-picked entry, which faked drift (a top-level
  // @babel/code-frame@7.29.7 flagged against a nested 8.0.0 that is ALSO legitimately locked+installed).
  const locked = new Map();       // name -> representative entry (hoisted/lowest-depth) = the version source
  const lockedVers = new Map();   // name -> Set(every locked version)
  for (const p of [...yarn, ...lock]) {
    const prev = locked.get(p.name);
    if (!prev || (p.depth || 1) < (prev.depth || 1)) locked.set(p.name, p); // strictly-lower depth = hoisted
    (lockedVers.get(p.name) || lockedVers.set(p.name, new Set()).get(p.name)).add(p.version);
  }
  const merged = [...locked.values()];
  const drift = [];
  for (const d of disk) {
    const vers = lockedVers.get(d.name);
    if (!vers) merged.push(d);
    else if (!vers.has(d.version)) drift.push({ name: d.name, locked: locked.get(d.name).version, installed: d.version });
  }
  return { installed: dedupe([...merged, ...py, ...go]), drift };
}
