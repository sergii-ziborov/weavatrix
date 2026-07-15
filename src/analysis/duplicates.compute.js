// duplicates.compute.js — fragment extraction, inverted-index pairing, and the computeDuplicates
// pipeline (split from duplicates.js; see the facade there for the full algorithm overview).
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { isTestPath } from "../graph/graph-filter.js";
import { stripNonCode, bodyEndLineCount, tokenize, fingerprints } from "./duplicates.tokenize.js";

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
