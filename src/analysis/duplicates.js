// duplicates.js — content-based clone detection over the repo's OWN graph.json symbols (the Health
// tab's engine). MOSS-style pipeline: symbol bodies (line ranges from the graph) → strip comments &
// string bodies → tokenize → k-gram rolling hashes → winnowing fingerprints → inverted index (no
// O(n²) all-pairs) → jaccard similarity. BOTH normalization modes are computed in one pass so every
// UI knob (similarity %, min size, strict/renamed) filters instantly on the renderer side:
//   strict  — identifiers kept: only literal copy-paste (Type-1 clones)
//   renamed — identifiers canonicalized to "I": catches copy-paste-then-rename (Type-2 clones)
// Pairs are reported down to the FLOOR values; the renderer slices from there upward.
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { Worker } from "node:worker_threads";
import { isTestPath } from "../graph/graph-filter.js";
import { graphOutDirForRepo } from "../graph/layout.js";

const K = 8;               // k-gram length (tokens)
const W = 4;               // winnowing window → guaranteed detection of matches ≥ K+W-1 tokens
const FLOOR_TOKENS = 30;   // fragments below this never enter the index (UI slider min)
const FLOOR_SIM = 0.5;     // pairs below this are not reported (UI slider min)
const MAX_BODY_LINES = 400;
// File types with no code SYMBOLS to fragment (stylesheets, markup, docs, single-file components). The
// user still wants them clone-checked ("check the frontend / md too"), so each is sliced into fixed line
// WINDOWS and each window is fingerprinted like a function body — a duplicated CSS rule block / HTML
// section / doc passage then clones the same way.
const WINDOW_EXTS = /\.(css|scss|sass|less|styl|html?|md|markdown|mdx|vue|svelte|astro)$/i;
const WINDOW_LINES = 24;   // non-overlapping block size for windowed files
// Asset files are DEDUP-ONLY — they are NOT put in the code graph (that would score md/css as fake
// "methods" in Health and clutter the GUI board), so the clone scanner finds them by walking the repo.
const WALK_SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", "vendor", "weavatrix-graphs", ".next", "out", "__pycache__", ".venv", "venv", "site-packages"]);
const MAX_ASSET_FILES = 4000;
function walkAssets(root, dir, acc, depth) {
  if (depth > 40 || acc.length >= MAX_ASSET_FILES) return acc;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (acc.length >= MAX_ASSET_FILES) break;
    if (e.name.startsWith(".") || WALK_SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkAssets(root, full, acc, depth + 1);
    else if (WINDOW_EXTS.test(e.name)) acc.push(full.slice(root.length + 1).replace(/\\/g, "/"));
  }
  return acc;
}
// Fingerprints shared by MORE than this many fragments are ubiquitous boilerplate and are excluded
// from BOTH the shared count AND the union (so jaccard stays honest — see pairsForMode). Set well
// above realistic clone multiplicity: N byte-identical copies each put all their fingerprints in
// buckets of size N, so the cap must exceed N or the whole clone family is invisible. 120 covers all
// but pathological mass-duplication; the O(n²) pair work per bucket stays bounded by it.
const BUCKET_CAP = 120;
// A clone must share at least this many DISTINCT (non-ubiquitous) fingerprints. Winnowing collapses a
// UNIFORM repetitive body (a constant table where every line is `KEY: 'VALUE',` → renamed `I: <str>`) to a
// handful of fingerprints, so two UNRELATED such tables hit 100% renamed Jaccard on ~3-6 shared fingerprints
// — "same shape, zero shared content". Requiring real shared evidence drops those false positives while a
// genuine clone (which shares dozens of fingerprints) is untouched.
const MIN_SHARED_FP = 8;
const STRLIT = String.fromCharCode(0); // opaque-literal sentinel for every string/regex body: a NUL
                           // its own class (never an identifier "I" nor a number "N"), so a literal can
                           // never masquerade as code in either mode

const KEYWORDS = new Set(("if else for while do switch case break continue return function const let var new class extends async await try catch finally throw import from export default typeof instanceof in of delete void yield static get set this super null undefined true false def elif except lambda pass raise with as is not and or None True False func go defer chan map range struct interface type package nil err string int bool byte float64 public private protected final void long double boolean").split(" "));

// A leading `/` is a REGEX literal (not division) when the previous significant char is one of these
// or the fragment start; after a word char / ) / ] it is division. Covers .match(/…/), = /…/, (/…/),
// and arrow `x => /…/`. NOTE: `+` and `-` are deliberately EXCLUDED — a regex never legitimately
// follows them, but `i++ / 2` and `a - b / c` do, and including them mis-scanned the division as a
// regex and ate the rest of the line.
const REGEX_PREV = new Set("(,=:[!&|?{};~*%^<>".split(""));

// Replace comments with nothing and string/regex BODIES with the sentinel, so their contents never
// count as code. Handles Python triple-quoted docstrings (embedded quotes no longer desync the scan)
// and JS regex literals (a quote inside /['"]/ no longer opens a phantom string).
function stripNonCode(text, py) {
  let out = "", i = 0, prevSig = "";
  const s = String(text || "");
  const push = (c) => { out += c; const t = c.trim(); if (t) prevSig = t[t.length - 1]; };
  while (i < s.length) {
    const ch = s[i], two = s.slice(i, i + 2), three = s.slice(i, i + 3);
    if (py && ch === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (py && (three === "'''" || three === '"""')) {
      i += 3;
      while (i < s.length && s.slice(i, i + 3) !== three) i++;
      i += 3; push(` ${STRLIT} `); continue;
    }
    if (!py && two === "//") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (!py && two === "/*") { i += 2; while (i < s.length && s.slice(i, i + 2) !== "*/") i++; i += 2; continue; }
    if (!py && ch === "/" && REGEX_PREV.has(prevSig)) {
      i++; let inClass = false; // '/' inside a [...] char class is literal, not the terminator
      while (i < s.length && s[i] !== "\n") {
        const c = s[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { i++; break; }
        i++;
      }
      while (i < s.length && /[a-z]/i.test(s[i])) i++; // regex flags (gimsuy)
      push(` ${STRLIT} `); continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      i++; push(` ${STRLIT} `); continue;
    }
    push(ch); i++;
  }
  return out;
}

// Where a symbol's body ends — so the LAST symbol in a file doesn't swallow trailing module-level code
// (module.exports tables, main() calls, handler registrations) up to EOF and dilute/misattribute
// clones. Brace/bracket depth for brace langs (body ends when {}()[] balance after first opening);
// indentation for Python. Returns a 1-based line count within bodyLines (≤ its length; = its length
// when the construct never closes, so the caller's cap stands).
function bodyEndLineCount(bodyLines, py) {
  if (py) {
    const base = bodyLines[0].match(/^[ \t]*/)[0].length;
    let last = 1;
    for (let k = 1; k < bodyLines.length; k++) {
      const ln = bodyLines[k];
      if (!ln.trim()) continue; // blank lines never end a block
      if (ln.match(/^[ \t]*/)[0].length <= base) return last; // dedent to ≤ the def → body ended above
      last = k + 1;
    }
    return bodyLines.length;
  }
  const text = bodyLines.join("\n");
  let depth = 0, opened = false, i = 0, line = 1, prevSig = "";
  while (i < text.length) {
    const ch = text[i], two = text.slice(i, i + 2);
    if (ch === "\n") { line++; i++; continue; }
    if (two === "//") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (two === "/*") { i += 2; while (i < text.length && text.slice(i, i + 2) !== "*/") { if (text[i] === "\n") line++; i++; } i += 2; continue; }
    if (ch === "/" && REGEX_PREV.has(prevSig)) {
      i++; let inClass = false;
      while (i < text.length && text[i] !== "\n") { const c = text[i]; if (c === "\\") { i += 2; continue; } if (c === "[") inClass = true; else if (c === "]") inClass = false; else if (c === "/" && !inClass) { i++; break; } i++; }
      prevSig = "/"; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { const q = ch; i++; while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; else if (text[i] === "\n") line++; i++; } i++; prevSig = q; continue; }
    // depth tracks all brackets, but only a { or [ opens the BODY — a bare (param list) returning to
    // depth 0 must not be read as the construct closing on line 1
    if (ch === "{" || ch === "(" || ch === "[") { depth++; if (ch === "{" || ch === "[") opened = true; }
    else if (ch === "}" || ch === ")" || ch === "]") { depth--; if (opened && depth <= 0) return line; }
    if (ch.trim()) prevSig = ch;
    i++;
  }
  return bodyLines.length;
}

// one raw token stream; the two modes differ only in identifier canonicalization
function tokenize(text) {
  const raw = text.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) || [];
  const strict = [];
  const renamed = [];
  for (const t of raw) {
    if (/^\d/.test(t)) { strict.push("N"); renamed.push("N"); continue; }
    if (/^[A-Za-z_$]/.test(t) && !KEYWORDS.has(t)) { strict.push(t); renamed.push("I"); continue; }
    strict.push(t); renamed.push(t);
  }
  return { strict, renamed };
}

function fingerprints(toks) {
  if (toks.length < K + W - 1) return new Set();
  const hashes = [];
  for (let i = 0; i + K <= toks.length; i++) {
    let h = 0;
    for (let j = i; j < i + K; j++) {
      const s = toks[j];
      for (let c = 0; c < s.length; c++) h = (h * 31 + s.charCodeAt(c)) | 0;
      h = (h * 131) | 0;
    }
    hashes.push(h >>> 0);
  }
  const fp = new Set();
  for (let i = 0; i + W <= hashes.length + 1; i++) {
    let min = Infinity;
    for (let j = i; j < Math.min(i + W, hashes.length); j++) if (hashes[j] < min) min = hashes[j];
    fp.add(min);
  }
  return fp;
}

function pairsForMode(frags, mode) {
  const index = new Map();
  frags.forEach((f, i) => { for (const h of f.fp[mode]) { let a = index.get(h); if (!a) index.set(h, (a = [])); a.push(i); } });
  // eff[i] = count of i's fingerprints that sit in NON-ubiquitous buckets. Jaccard's numerator (shared)
  // and denominator (union) are BOTH computed over this same restricted set, so excluding a boilerplate
  // fingerprint never deflates similarity — two real clones sharing a widely-repeated preamble still
  // pair at 100% on their unique bodies, and the sim is a true jaccard, not an under-count.
  const eff = new Array(frags.length).fill(0);
  const shared = new Map();
  for (const arr of index.values()) {
    if (arr.length > BUCKET_CAP) continue; // ubiquitous k-gram → excluded from count AND size (both sides)
    for (const idx of arr) eff[idx]++;
    for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) {
      const key = arr[a] * 1000000 + arr[b]; // frag count is bounded way below 1e6
      shared.set(key, (shared.get(key) || 0) + 1);
    }
  }
  const pairs = [];
  for (const [key, count] of shared) {
    const i = Math.floor(key / 1000000), j = key % 1000000;
    const union = eff[i] + eff[j] - count;
    const sim = union > 0 ? count / union : 0;
    if (sim >= FLOOR_SIM && count >= MIN_SHARED_FP) pairs.push([i, j, Math.round(sim * 100)]);
  }
  return pairs;
}

// Parse "L<line>" graph symbol locations into per-file ordered symbol lists.
function symbolRanges(graph) {
  const byFile = new Map();
  for (const n of graph.nodes || []) {
    if (!n.source_file || !String(n.id || "").includes("#")) continue;
    const line = Number((String(n.source_location || "").match(/L(\d+)/) || [])[1] || 0);
    if (!line) continue;
    let arr = byFile.get(n.source_file);
    if (!arr) byFile.set(n.source_file, (arr = []));
    arr.push({ id: n.id, label: n.label || n.id, line });
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a.line - b.line);
  return byFile;
}

export function computeDuplicates(repoPath, graphJsonPath) {
  const graph = JSON.parse(readFileSync(graphJsonPath, "utf8"));
  const byFile = symbolRanges(graph);
  // total symbol nodes in the graph — 0 means a file-only graph (built by an older builder before
  // symbol extraction, or a stale graph): clone detection has nothing to work with, and the UI must
  // say "rebuild the graph" instead of the misleading "no clones at these thresholds".
  let graphSymbols = 0;
  for (const arr of byFile.values()) graphSymbols += arr.length;
  const frags = [];
  for (const [file, syms] of byFile) {
    const full = join(repoPath, file);
    let lines;
    try { lines = readFileSync(full, "utf8").split(/\r?\n/); } catch { continue; }
    const py = /\.py$/i.test(file);
    for (let i = 0; i < syms.length; i++) {
      const start = syms[i].line;
      // hard cap first (next symbol, or EOF, whichever comes first, ≤ MAX_BODY_LINES) …
      const hardEnd = Math.min(i + 1 < syms.length ? syms[i + 1].line - 1 : lines.length, start + MAX_BODY_LINES);
      if (hardEnd - start < 2) continue; // one-liners can't be meaningful clones
      // … then shrink to where the construct actually closes, so the last symbol doesn't absorb
      // trailing module-level code (module.exports tables, main() calls) up to EOF.
      const bodyLines = lines.slice(start - 1, hardEnd);
      const body = bodyLines.slice(0, bodyEndLineCount(bodyLines, py));
      const end = start + body.length - 1;
      if (end - start < 2) continue;
      const toks = tokenize(stripNonCode(body.join("\n"), py));
      if (toks.strict.length < FLOOR_TOKENS) continue;
      frags.push({
        id: syms[i].id, label: syms[i].label, file, start, end,
        n: toks.strict.length,
        test: isTestPath(file),
        fp: { strict: fingerprints(toks.strict), renamed: fingerprints(toks.renamed) },
      });
    }
  }
  // ---- windowed fragments for symbol-less file types (CSS/HTML/MD/…), found by walking the repo (NOT the
  // graph — assets are dedup-only). Each file is sliced into WINDOW_LINES blocks and fingerprinted.
  const symFiles = new Set(byFile.keys());
  for (const file of walkAssets(repoPath, repoPath, [], 0)) {
    if (symFiles.has(file)) continue;
    let lines;
    try { lines = readFileSync(join(repoPath, file), "utf8").split(/\r?\n/); } catch { continue; }
    for (let start = 1; start <= lines.length; start += WINDOW_LINES) {
      const end = Math.min(start + WINDOW_LINES - 1, lines.length);
      if (end - start < 2) continue;
      const toks = tokenize(stripNonCode(lines.slice(start - 1, end).join("\n"), false));
      if (toks.strict.length < FLOOR_TOKENS) continue;
      frags.push({
        id: `${file}#win@${start}`, label: `${file.split("/").pop()}:${start}-${end}`, file, start, end,
        n: toks.strict.length, test: isTestPath(file),
        fp: { strict: fingerprints(toks.strict), renamed: fingerprints(toks.renamed) },
      });
    }
  }
  const modes = { strict: pairsForMode(frags, "strict"), renamed: pairsForMode(frags, "renamed") };
  // fp sets are worker-internal — strip them from the payload that crosses the thread boundary
  const slim = frags.map(({ fp, ...rest }) => rest);
  return { ok: true, frags: slim, modes, graphSymbols, floors: { tokens: FLOOR_TOKENS, sim: FLOOR_SIM * 100 } };
}

function computeInWorker(repoPath, graphJsonPath) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./duplicates-worker.js", import.meta.url), { workerData: { repoPath, graphJsonPath } });
    } catch (e) {
      reject(Object.assign(e, { workerStartFailed: true }));
      return;
    }
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    worker.once("message", (msg) => done(resolve, msg));
    worker.once("error", (e) => done(reject, Object.assign(e, { workerStartFailed: true })));
    worker.once("exit", (code) => { if (code !== 0) done(reject, Object.assign(new Error(`duplicates worker exited with code ${code}`), { workerStartFailed: true })); });
  });
}

// repos:duplicates entry — cached per (repo, graph.json mtime): re-running with an unchanged graph is
// free. `force` (the UI's ↻ rescan) bypasses the cache: fragment BODIES are read from live source, so a
// source edit that didn't rebuild the graph (same mtime) must still be re-scanned on demand.
const _cache = new Map();
export async function runDuplicates(repoPath, force = false) {
  const repo = String(repoPath || "");
  if (!repo || !existsSync(repo)) return { ok: false, error: "Repo path not found" };
  const graphJsonPath = join(graphOutDirForRepo(repo), "graph.json");
  if (!existsSync(graphJsonPath)) {
    return { ok: false, needsGraph: true, error: "No graph yet — build the Relations graph first (↻ on the Relations tab)" };
  }
  let mtime = 0;
  try { mtime = statSync(graphJsonPath).mtimeMs; } catch { /* treat as uncached */ }
  const cached = _cache.get(repo);
  if (!force && cached && cached.mtime === mtime) return cached.result;
  let result;
  try {
    result = await computeInWorker(repo, graphJsonPath);
  } catch (e) {
    if (!e || !e.workerStartFailed) return { ok: false, error: e.message || String(e) };
    try { result = computeDuplicates(repo, graphJsonPath); } // in-process fallback (exotic packaging)
    catch (e2) { return { ok: false, error: e2.message || String(e2) }; }
  }
  if (result && result.ok) _cache.set(repo, { mtime, result });
  return result;
}
