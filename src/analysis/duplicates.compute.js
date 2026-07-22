// duplicates.compute.js — fragment extraction, inverted-index pairing, and the computeDuplicates
// pipeline (split from duplicates.js; see the facade there for the full algorithm overview).
import { readFileSync } from "node:fs";
import { createRepoBoundary } from "../repo-path.js";
import { createPathClassifier, hasPathClass } from "../path-classification.js";
import { listRepoFiles } from "./internal-audit.collect.js";
import { stripNonCode, bodyEndLineCount, tokenize, fingerprints, extractLargeStrings } from "./duplicates.tokenize.js";

const FLOOR_TOKENS = 12;   // absolute safety floor; normal scans still default to 30+ tokens
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
const MAX_ASSET_FILES = 4000;
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

// Same-name symbols across DIFFERENT files — the semantic complement to token clones. A token clone
// says "same body"; a name twin with LOW similarity says "same name, different behavior" — the
// drift-hazard class of duplicate (three divergent uniqueStrings() implementations) that jaccard
// ranks too low to surface. OOP-generic lifecycle names are stoplisted; interface implementations
// still appear, so the caller's report keeps neutral wording.
const TWIN_STOP = new Set(["constructor", "tostring", "valueof", "dispose", "close", "render", "setup", "teardown", "initialize", "destroy", "connect", "disconnect", "update", "reset", "clear", "create", "handle", "execute", "invoke", "main", "start", "stop", "build", "parse", "value", "index"]);
function computeNameTwins(frags) {
  const byName = new Map();
  frags.forEach((f, i) => {
    if (f.kind === "string") return;
    const name = String(f.label || "").trim().replace(/\(\)$/, "");
    if (name.length < 5 || !/^[A-Za-z_$][\w$]*$/.test(name) || TWIN_STOP.has(name.toLowerCase()) || /^do_(?:get|post|put|patch|delete|head|options)$/i.test(name)) return;
    const key = name.toLowerCase();
    let a = byName.get(key); if (!a) byName.set(key, (a = []));
    a.push(i);
  });
  const jac = (A, B) => { let inter = 0; for (const h of A) if (B.has(h)) inter++; const u = A.size + B.size - inter; return u ? inter / u : 0; };
  const out = [];
  for (const idxs of byName.values()) {
    const files = new Set(idxs.map((i) => frags[i].file));
    if (files.size < 2 || idxs.length > 12) continue; // single-file overloads / framework-name explosions
    let simMin = 1, simMax = 0;
    const pairs = [];
    for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) {
      if (frags[idxs[a]].file === frags[idxs[b]].file) continue;
      const s = jac(frags[idxs[a]].fp.renamed, frags[idxs[b]].fp.renamed);
      if (s < simMin) simMin = s;
      if (s > simMax) simMax = s;
      pairs.push({ a: idxs[a], b: idxs[b], similarity: Math.round(s * 100) });
    }
    out.push({
      label: String(frags[idxs[0]].label || "").replace(/\(\)$/, ""), members: idxs, files: files.size,
      simMin: Math.round(simMin * 100), simMax: Math.round(simMax * 100),
      pairs,
      tokens: idxs.reduce((n, i) => n + frags[i].n, 0),
    });
  }
  return out.sort((x, y) => y.tokens - x.tokens).slice(0, 200);
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
    const smallFragment = Math.min(frags[i].n, frags[j].n) < 30;
    const enoughEvidence = smallFragment
      ? sim >= 0.95 && count >= 2
      : count >= MIN_SHARED_FP;
    if (sim >= FLOOR_SIM && enoughEvidence) pairs.push([i, j, Math.round(sim * 100)]);
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
    arr.push({ id: n.id, label: n.label || n.id, line, symbolKind: n.symbol_kind || "", testSurface: n.test_surface === true });
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a.line - b.line);
  return byFile;
}

function loadGraph(graphInput) {
  if (graphInput && typeof graphInput === "object" && !Array.isArray(graphInput)) {
    return { nodes: Array.isArray(graphInput.nodes) ? graphInput.nodes : [] };
  }
  if (typeof graphInput !== "string" || !graphInput) throw new TypeError("graph path or graph object is required");
  const parsed = JSON.parse(readFileSync(graphInput, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("graph must be an object");
  return { nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [] };
}

export function computeDuplicates(repoPath, graphJsonPath, opts = {}) {
  const includeStrings = !!opts.includeStrings;
  const scanTokenFloor = Math.max(FLOOR_TOKENS, Math.min(400, Number(opts.minTokens) || 30));
  const graph = loadGraph(graphJsonPath);
  const byFile = symbolRanges(graph);
  // total symbol nodes in the graph — 0 means a file-only graph (built by an older builder before
  // symbol extraction, or a stale graph): clone detection has nothing to work with, and the UI must
  // say "rebuild the graph" instead of the misleading "no clones at these thresholds".
  const repoFiles = listRepoFiles(repoPath);
  const allowedFiles = new Set(repoFiles);
  let graphSymbols = 0;
  for (const [file, arr] of byFile) if (allowedFiles.has(file)) graphSymbols += arr.length;
  const frags = [];
  const boundary = createRepoBoundary(repoPath);
  const classifier = createPathClassifier(repoPath);
  const classificationByFile = new Map();
  const classify = (file, content) => {
    if (!classificationByFile.has(file)) classificationByFile.set(file, classifier.explain(file, { content }));
    return classificationByFile.get(file);
  };
  const classificationFields = (info) => ({
    test: hasPathClass(info, "test", "e2e"),
    classes: info.classes,
    excluded: info.excluded,
    matchedRule: info.matchedRule,
  });
  for (const [file, syms] of byFile) {
    if (!allowedFiles.has(file)) continue;
    const resolved = boundary.resolve(file);
    if (!resolved.ok) continue;
    const full = resolved.path;
    let lines;
    try { lines = readFileSync(full, "utf8").split(/\r?\n/); } catch { continue; }
    const py = /\.py$/i.test(file);
    const pathInfo = classify(file, lines.join("\n"));
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
      if (toks.strict.length < scanTokenFloor) continue;
      const strippedBody = stripNonCode(body.join("\n"), py);
      const declarativeValue = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+(?:\s*:[^=]+)?\s*=\s*(?:Object\.(?:freeze|seal)\s*\(\s*)?[\[{]/s.test(strippedBody.trim())
        && !/=>|\b(?:function|if|for|while|switch|try|await|yield|return|throw|new)\b/.test(strippedBody);
      const declarativeFactory = /^(?:export\s+)?const\s+[\w$]+(?:\s*:[^=]+)?\s*=\s*(?:sqliteTable|pgTable|mysqlTable)\s*\(/s.test(strippedBody.trim());
      const declarative = declarativeValue || declarativeFactory || /^(?:interface|type|enum)$/i.test(syms[i].symbolKind);
      frags.push({
        id: syms[i].id, label: syms[i].label, file, start, end,
        n: toks.strict.length, declarative,
        ...classificationFields(pathInfo),
        // Inline test surfaces (Rust `#[cfg(test)] mod tests`, `#[test]` fns) live in production files, so a
        // path check alone misses them; the graph already flags the symbol. OR it in so skip-tests suppresses
        // them by default and two #[test] fns are never reported as a production clone.
        test: hasPathClass(pathInfo, "test", "e2e") || syms[i].testSurface === true,
        fp: { strict: fingerprints(toks.strict), renamed: fingerprints(toks.renamed) },
      });
    }
    // ---- opt-in: large multi-line string literals as their own fragments. The code pass above strips
    // string bodies (correctly — content isn't code), which makes embedded DSL templates (inline
    // C#/SQL/PowerShell) invisible to clone detection. Tokenized RAW: the content IS the payload.
    if (includeStrings) {
      const base = file.split("/").pop();
      const pushStr = (startLine, endLine, content) => {
        const toks = tokenize(content);
        if (toks.strict.length < scanTokenFloor) return;
        frags.push({
          id: `${file}#str@${startLine}`, label: `${base}:${startLine} ~${endLine - startLine + 1}-line string`,
          file, start: startLine, end: endLine, n: toks.strict.length, ...classificationFields(pathInfo), kind: "string",
          fp: { strict: fingerprints(toks.strict), renamed: fingerprints(toks.renamed) },
        });
      };
      for (const str of extractLargeStrings(lines.join("\n"), { py, cs: /\.cs$/i.test(file) })) {
        const strLines = str.content.split(/\r?\n/).slice(0, MAX_BODY_LINES);
        // A SECTION shared between two big templates dilutes below the similarity floor when the whole
        // literals are compared (70 shared lines inside 220- and 107-line strings ≈ 27% jaccard). Big
        // literals therefore get the same WINDOW treatment as CSS/HTML files; small ones stay whole.
        if (strLines.length <= WINDOW_LINES * 2) {
          pushStr(str.start, str.start + strLines.length - 1, strLines.join("\n"));
        } else {
          for (let off = 0; off < strLines.length; off += WINDOW_LINES) {
            const chunk = strLines.slice(off, off + WINDOW_LINES);
            if (chunk.length < 3) break;
            pushStr(str.start + off, str.start + off + chunk.length - 1, chunk.join("\n"));
          }
        }
      }
    }
  }
  // ---- windowed fragments for symbol-less file types (CSS/HTML/MD/…), found by walking the repo (NOT the
  // graph — assets are dedup-only). Each file is sliced into WINDOW_LINES blocks and fingerprinted.
  const symFiles = new Set(byFile.keys());
  const allAssetFiles = repoFiles.filter((file) => WINDOW_EXTS.test(file));
  const assetFiles = allAssetFiles.slice(0, MAX_ASSET_FILES);
  for (const file of assetFiles) {
    if (symFiles.has(file)) continue;
    const resolved = boundary.resolve(file);
    if (!resolved.ok) continue;
    let lines;
    try { lines = readFileSync(resolved.path, "utf8").split(/\r?\n/); } catch { continue; }
    const pathInfo = classify(file, lines.join("\n"));
    for (let start = 1; start <= lines.length; start += WINDOW_LINES) {
      const end = Math.min(start + WINDOW_LINES - 1, lines.length);
      if (end - start < 2) continue;
      const toks = tokenize(stripNonCode(lines.slice(start - 1, end).join("\n"), false));
      if (toks.strict.length < scanTokenFloor) continue;
      frags.push({
        id: `${file}#win@${start}`, label: `${file.split("/").pop()}:${start}-${end}`, file, start, end,
        n: toks.strict.length, ...classificationFields(pathInfo),
        fp: { strict: fingerprints(toks.strict), renamed: fingerprints(toks.renamed) },
      });
    }
  }
  const modes = { strict: pairsForMode(frags, "strict"), renamed: pairsForMode(frags, "renamed") };
  const nameTwins = opts.nameTwins ? computeNameTwins(frags) : null;
  // fp sets are worker-internal — strip them from the payload that crosses the thread boundary
  const slim = frags.map(({ fp, ...rest }) => rest);
  return {
    ok: true,
    frags: slim,
    modes,
    ...(nameTwins ? { nameTwins } : {}),
    graphSymbols,
    completeness: {
      assetFiles: {
        total: allAssetFiles.length,
        scanned: assetFiles.length,
        truncated: allAssetFiles.length > assetFiles.length,
      },
      nameTwinsTruncated: !!nameTwins && nameTwins.length >= 200,
    },
    floors: { tokens: scanTokenFloor, absoluteTokens: FLOOR_TOKENS, sim: FLOOR_SIM * 100 },
  };
}
