// Pure manifest parsers for the non-npm ecosystems (Go + Python) — text in, declared deps out.
// NO filesystem here (internal-audit.js is the fs wrapper; internal-builder reads go.mod for resolvers).
// Philosophy matches dep-check.js: tolerate real-world files, bias to FALSE-NEGATIVES on weird syntax.

// pep503(name) — PyPI canonical form: lowercase, runs of -_. collapse to "-" (same as security/installed.js).
export const pep503 = (name) => String(name || "").toLowerCase().replace(/[-_.]+/g, "-");

// ---- go.mod → { module, requires: [{path, version, indirect}], replaces: [{from, to}] } ----
// Handles single-line `require path v1` and `require ( … )` blocks; `// indirect` marks transitive
// requires (never flagged unused — Go owns them via `go mod tidy`).
export function parseGoMod(text) {
  const src = String(text || "");
  const out = { module: "", requires: [], replaces: [] };
  const m = src.match(/^\s*module\s+(\S+)/m);
  if (m) out.module = m[1].replace(/^"|"$/g, "");
  const addReq = (line) => {
    const r = line.match(/^\s*([^\s()=>]+)\s+(v[\w.+-]+)\s*(\/\/.*)?$/);
    if (r) out.requires.push({ path: r[1].replace(/^"|"$/g, ""), version: r[2], indirect: /\/\/\s*indirect/.test(line) });
  };
  const addRepl = (line) => {
    const r = line.match(/^\s*([^\s()=>]+)(?:\s+v[\w.+-]+)?\s*=>\s*(\S+)(?:\s+v[\w.+-]+)?\s*(\/\/.*)?$/);
    if (r) out.replaces.push({ from: r[1].replace(/^"|"$/g, ""), to: r[2].replace(/^"|"$/g, "") });
  };
  for (const dir of ["require", "replace"]) {
    const add = dir === "require" ? addReq : addRepl;
    for (const blk of src.matchAll(new RegExp(`^\\s*${dir}\\s*\\(([\\s\\S]*?)^\\s*\\)`, "gm"))) for (const line of blk[1].split(/\r?\n/)) add(line);
    for (const one of src.matchAll(new RegExp(`^\\s*${dir}\\s+([^(\\r\\n]+)$`, "gm"))) add(one[1]);
  }
  return out;
}

// ---- PEP 508 requirement line → dist name (extras/specifiers/markers stripped), or null ----
// "-r other.txt", bare options, paths and URLs are skipped; VCS urls keep their #egg= name if present.
export function requirementName(rawLine) {
  const line = String(rawLine || "").replace(/(^|\s)#.*$/, "").trim();
  if (!line) return null;
  const egg = line.match(/#egg=([A-Za-z0-9][\w.-]*)/i);
  if (egg) return egg[1];
  if (line.startsWith("-") || /^(git\+|hg\+|svn\+|bzr\+|https?:|file:)/i.test(line) || /^\.{0,2}[\\/]/.test(line) || line === ".") return null;
  const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? m[1] : null;
}

// requirements.txt (or *.in) text → [{name}] (unique by canonical name)
export function parseRequirementsNames(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const name = requirementName(raw);
    if (!name || seen.has(pep503(name))) continue;
    seen.add(pep503(name));
    out.push({ name });
  }
  return out;
}

// ---- pyproject.toml → { present, deps: [{name, dev, buildSystem}] } ----
// Line-based section scanner (no TOML dependency): covers PEP 621 [project] dependencies /
// optional-dependencies, Poetry [tool.poetry.*dependencies] tables, PEP 735 [dependency-groups],
// and [build-system] requires (declared-but-implicit → suppresses "missing", never checked "unused").
export function parsePyprojectDeps(text) {
  const src = String(text || "");
  const deps = [];
  const seen = new Set();
  const add = (name, dev, buildSystem = false) => {
    if (!name || name.toLowerCase() === "python" || seen.has(pep503(name))) return;
    seen.add(pep503(name));
    deps.push({ name, dev: !!dev, buildSystem });
  };
  let section = "";
  let present = false;
  let arr = null; // { dev, buildSystem } while inside a dependencies = [ … ] array
  // bracket balance OUTSIDE string literals — "requests[security]" must not close the array
  const bracketDelta = (s) => { const t = String(s).replace(/"[^"]*"|'[^']*'/g, ""); return ((t.match(/\[/g) || []).length) - ((t.match(/\]/g) || []).length); };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    const sec = line.match(/^\s*\[+([^\]]+)\]+\s*$/);
    if (!arr && sec) { section = sec[1].trim(); continue; }
    if (arr) { // inside a multi-line array: pull every string literal
      for (const s of line.matchAll(/["']([^"']+)["']/g)) add(requirementName(s[1]), arr.dev, arr.buildSystem);
      if (bracketDelta(line) < 0) arr = null;
      continue;
    }
    const kv = line.match(/^\s*([\w."'-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, "");
    const val = kv[2].trim();
    const startArray = (dev, buildSystem = false) => {
      present = true;
      for (const s of val.matchAll(/["']([^"']+)["']/g)) add(requirementName(s[1]), dev, buildSystem);
      if (bracketDelta(val) > 0) arr = { dev, buildSystem };
    };
    if (section === "project" && key === "dependencies") startArray(false);
    else if (section === "project.optional-dependencies" || section === "dependency-groups") startArray(true);
    else if (section === "build-system" && key === "requires") startArray(true, true);
    else if (section === "tool.poetry.dependencies") { present = true; add(key, false); }
    else if (section === "tool.poetry.dev-dependencies" || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) { present = true; add(key, true); }
  }
  return { present, deps };
}

// ---- Pipfile → { present, deps: [{name, dev}] } — [packages] / [dev-packages] table keys ----
export function parsePipfileDeps(text) {
  const deps = [];
  const seen = new Set();
  let section = "";
  let present = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }
    if (section !== "packages" && section !== "dev-packages") continue;
    const kv = line.match(/^["']?([A-Za-z0-9][\w.-]*)["']?\s*=/);
    if (!kv || seen.has(pep503(kv[1]))) continue;
    present = true;
    seen.add(pep503(kv[1]));
    deps.push({ name: kv[1], dev: section === "dev-packages" });
  }
  return { present, deps };
}
