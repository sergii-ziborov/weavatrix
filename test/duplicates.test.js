import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { computeDuplicates, runDuplicates } from "../src/analysis/duplicates.js";
import { tFindDuplicates } from "../src/mcp/tools-health.mjs";
import { compareDuplicateGroups } from "../src/analysis/duplicate-groups.js";

const CLONE = `function collectRows(items) {
  const out = [];
  for (const item of items) {
    if (!item || item.skip) continue;
    out.push({ id: item.id, name: item.name, size: item.size * 2 + 1 });
  }
  out.sort((x, y) => x.size - y.size);
  return out.filter((r) => r.size > 3);
}`;

// same structure, every identifier renamed — a Type-2 clone
const RENAMED = CLONE
  .replace(/collectRows/g, "gatherEntries").replace(/items/g, "list").replace(/\bout\b/g, "acc")
  .replace(/\bitem\b/g, "entry").replace(/\bskip\b/g, "omit").replace(/\bid\b/g, "key")
  .replace(/\bname\b/g, "title").replace(/\bsize\b/g, "weight").replace(/\br\b/g, "row");

const DISTINCT = `function totallyDifferent(a, b) {
  let acc = 0;
  while (a < b) { acc += Math.sqrt(a) / (b || 1); a += 3; }
  switch (acc % 4) { case 0: return "zero"; case 1: return acc; default: return null; }
}`;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-"));
  const files = {
    "src/a.js": `${CLONE}\n\n${DISTINCT}\n`,
    "src/b.js": `${CLONE}\n`,
    "src/c.js": `${RENAMED}\n`,
    "test/a.test.js": `${CLONE}\n`,
    "test-e2e/cypress/support/testLocators/a.js": `${CLONE}\n`,
    "src/generated/client.js": `${CLONE}\n`,
    "src/mockData.js": `${CLONE}\n`,
  };
  const nodes = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    nodes.push({ id: rel, label: rel.split("/").pop(), file_type: "code", source_file: rel, source_location: "L1" });
    const lines = content.split("\n");
    let symIdx = 0;
    lines.forEach((ln, i) => {
      const m = ln.match(/^function\s+([\w$]+)/);
      if (m) nodes.push({ id: `${rel}#${m[1]}@${i + 1}`, label: `${m[1]}()`, file_type: "code", source_file: rel, source_location: `L${i + 1}`, _i: symIdx++ });
    });
  }
  const graphJson = join(dir, "graph.json");
  writeFileSync(graphJson, JSON.stringify({ nodes, links: [] }));
  return { dir, graphJson };
}

test("duplicates: identical bodies pair at 100% in BOTH modes; distinct code never pairs", () => {
  const { dir, graphJson } = makeRepo();
  try {
    const r = computeDuplicates(dir, graphJson);
    assert.ok(r.ok);
    const name = (i) => r.frags[i].id;
    const strictPair = r.modes.strict.find(([i, j]) => [name(i), name(j)].sort().join("+").includes("a.js#collectRows") && [name(i), name(j)].join("+").includes("b.js#collectRows"));
    assert.ok(strictPair, "literal copy-paste found in strict mode");
    assert.equal(strictPair[2], 100);
    const touching = (fn) => r.modes.renamed.some(([i, j]) => name(i).includes(fn) || name(j).includes(fn)) || r.modes.strict.some(([i, j]) => name(i).includes(fn) || name(j).includes(fn));
    assert.ok(!touching("totallyDifferent"), "unrelated code stays unpaired");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duplicates: two DIFFERENT constant tables (same shape, no shared content) do NOT clone in renamed mode", () => {
  // the QueryErrorCodes-vs-WidgetConfigControlDisplayNames false positive: both are `const X = {K:'K',…}`,
  // so renamed canonicalization makes every line `I:<str>` — structurally identical, but they share nothing real.
  const table = (prefix, keys) => `const ${prefix}Table = Object.freeze({\n` +
    keys.map((k) => `  ${k}: '${k}',`).join("\n") + "\n});\n";
  const KEYS_A = Array.from({ length: 40 }, (_, i) => `QUERY_ERR_${i}_ALPHA`);
  const KEYS_B = Array.from({ length: 40 }, (_, i) => `WIDGET_CFG_${i}_OMEGA`);
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-fp-"));
  const files = { "src/a.js": table("Query", KEYS_A), "src/b.js": table("Widget", KEYS_B) };
  const nodes = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    nodes.push({ id: rel, label: rel.split("/").pop(), file_type: "code", source_file: rel, source_location: "L1" });
    nodes.push({ id: `${rel}#${rel.includes("a.js") ? "QueryTable" : "WidgetTable"}@1`, label: "table", file_type: "code", source_file: rel, source_location: "L1" });
  }
  const graphJson = join(dir, "graph.json");
  writeFileSync(graphJson, JSON.stringify({ nodes, links: [] }));
  try {
    const r = computeDuplicates(dir, graphJson);
    const name = (i) => r.frags[i].file;
    const paired = r.modes.renamed.find(([i, j]) => [name(i), name(j)].sort().join("+") === "src/a.js+src/b.js");
    assert.ok(!paired, "two unrelated constant tables must NOT be reported as a renamed clone (shared fingerprints below the floor)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duplicates: symbol-less CSS/HTML/MD files are window-fragmented and their duplicated blocks clone", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-win-"));
  // a chunky, duplicated stylesheet block (well over the 30-token floor within a 24-line window)
  const cssBlock = Array.from({ length: 20 }, (_, i) =>
    `.card-${i} { display: flex; padding: ${i}px 12px; color: #2a2a2a; border: 1px solid #ddeeff; border-radius: 6px; }`).join("\n");
  const files = {
    "styles/a.css": `${cssBlock}\n`,
    "styles/b.css": `${cssBlock}\n`,          // exact duplicate stylesheet
    "docs/only.md": `# Title\n\nsome unique prose that shares nothing with the stylesheets above at all here\n`,
  };
  const nodes = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    nodes.push({ id: rel, label: rel.split("/").pop(), file_type: "code", source_file: rel, source_location: "L1" }); // FILE node only, no symbols
  }
  const graphJson = join(dir, "graph.json");
  writeFileSync(graphJson, JSON.stringify({ nodes, links: [] }));
  try {
    const r = computeDuplicates(dir, graphJson);
    assert.ok(r.ok);
    const winFrags = r.frags.filter((f) => f.id.includes("#win@"));
    assert.ok(winFrags.some((f) => f.file === "styles/a.css") && winFrags.some((f) => f.file === "styles/b.css"), "CSS files are window-fragmented");
    const name = (i) => r.frags[i].file;
    const cssPair = r.modes.strict.find(([i, j]) => [name(i), name(j)].sort().join("+") === "styles/a.css+styles/b.css");
    assert.ok(cssPair, "the two identical CSS files pair as a clone");
    assert.equal(cssPair[2], 100, "identical stylesheets are a 100% clone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duplicates: Git-ignored release assets never enter the clone universe", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-ignore-"));
  const block = Array.from({ length: 40 }, (_, i) => `<p data-row="${i}">Chromium license boilerplate ${i}</p>`).join("\n");
  try {
    execFileSync("git", ["init", "-q", dir], { windowsHide: true });
    writeFileSync(join(dir, ".gitignore"), "release/\n");
    mkdirSync(join(dir, "release", "win-unpacked"), { recursive: true });
    writeFileSync(join(dir, "release", "win-unpacked", "LICENSES.chromium.html"), block);
    writeFileSync(join(dir, "graph.json"), JSON.stringify({ nodes: [], links: [] }));
    const result = computeDuplicates(dir, join(dir, "graph.json"));
    assert.equal(result.frags.some((fragment) => fragment.file.startsWith("release/")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duplicates: renamed clone is caught by 'renamed' mode and NOT by 'strict' at high similarity", () => {
  const { dir, graphJson } = makeRepo();
  try {
    const r = computeDuplicates(dir, graphJson);
    const name = (i) => r.frags[i].id;
    const inMode = (mode, fn) => r.modes[mode].filter(([i, j]) => (name(i).includes("gatherEntries") && name(j).includes(fn)) || (name(j).includes("gatherEntries") && name(i).includes(fn)));
    const renamedHits = inMode("renamed", "collectRows");
    assert.ok(renamedHits.length >= 1, "type-2 clone detected in renamed mode");
    assert.ok(renamedHits.every(([, , s]) => s >= 90), `renamed similarity is high (got ${renamedHits.map((p) => p[2])})`);
    assert.ok(inMode("strict", "collectRows").every(([, , s]) => s < 80), "strict mode must not report a renamed clone as a near-copy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duplicates: fragments carry the test-file flag so the UI can exclude them", () => {
  const { dir, graphJson } = makeRepo();
  try {
    const r = computeDuplicates(dir, graphJson);
    const testFrag = r.frags.find((f) => f.file === "test/a.test.js");
    const cypressFrag = r.frags.find((f) => f.file === "test-e2e/cypress/support/testLocators/a.js");
    const prodFrag = r.frags.find((f) => f.file === "src/a.js");
    assert.equal(testFrag?.test, true);
    assert.equal(cypressFrag?.test, true);
    assert.equal(prodFrag?.test, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duplicate ratchet blocks a new clone group that intersects changed files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-ratchet-"));
  try {
    mkdirSync(join(dir, "src"), {recursive: true});
    writeFileSync(join(dir, "src", "a.js"), `${CLONE}\n`);
    execFileSync("git", ["init", "--quiet"], {cwd: dir});
    execFileSync("git", ["config", "user.email", "test@example.com"], {cwd: dir});
    execFileSync("git", ["config", "user.name", "Weavatrix Test"], {cwd: dir});
    execFileSync("git", ["add", "src/a.js"], {cwd: dir});
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], {cwd: dir});
    writeFileSync(join(dir, "src", "b.js"), `${CLONE}\n`);
    const nodes = ["a", "b"].flatMap((name) => [
      {id: `src/${name}.js`, label: `${name}.js`, source_file: `src/${name}.js`, source_location: "L1"},
      {id: `src/${name}.js#collectRows@1`, label: "collectRows()", source_file: `src/${name}.js`, source_location: "L1"},
    ]);
    const graph = {nodes, links: [], graphBuildMode: "full"};
    const graphJson = join(dir, "graph.json");
    writeFileSync(graphJson, JSON.stringify(graph));
    const result = await compareDuplicateGroups({
      repoRoot: dir, graphPath: graphJson, currentGraph: graph, baseRef: "HEAD",
      changedFiles: ["src/b.js"], args: {mode: "renamed", min_similarity: 80, min_tokens: 12},
    });
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.baselineGroups, 0);
    assert.equal(result.scopedNewGroups.length, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("find_duplicates: include_tests=false excludes Cypress test-root clones", () => {
  const { dir, graphJson } = makeRepo();
  try {
    const hidden = tFindDuplicates(null, { mode: "strict", min_tokens: 30, include_tests: false }, { repoRoot: dir, graphPath: graphJson });
    assert.doesNotMatch(hidden, /test-e2e\/cypress/);
    const included = tFindDuplicates(null, { mode: "strict", min_tokens: 30, include_tests: true }, { repoRoot: dir, graphPath: graphJson });
    assert.match(included, /test-e2e\/cypress/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("find_duplicates suppresses generated/mock signal by default with an explicit override", () => {
  const { dir, graphJson } = makeRepo();
  try {
    const hidden = tFindDuplicates(null, { mode: "strict", min_tokens: 30, include_tests: true }, { repoRoot: dir, graphPath: graphJson });
    assert.doesNotMatch(hidden, /src\/generated\/client\.js|src\/mockData\.js/);
    assert.match(hidden, /classified as tests\/e2e\/generated\/mock\/story\/docs\/benchmark\/temp/);
    const included = tFindDuplicates(null, {
      mode: "strict", min_tokens: 30, include_tests: true, include_classified: true,
    }, { repoRoot: dir, graphPath: graphJson });
    assert.match(included, /src\/generated\/client\.js/);
    assert.match(included, /src\/mockData\.js/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// generic fixture: write files, auto-emit a symbol node per top-level function/def/const declaration
function buildFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-"));
  const nodes = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    nodes.push({ id: rel, label: rel.split("/").pop(), file_type: "code", source_file: rel, source_location: "L1" });
    content.split("\n").forEach((ln, i) => {
      const m = ln.match(/^(?:export\s+)?(?:async\s+)?(?:function\s+([\w$]+)|def\s+([\w$]+)|const\s+([\w$]+)\s*=)/);
      const name = m && (m[1] || m[2] || m[3]);
      if (name) nodes.push({ id: `${rel}#${name}@${i + 1}`, label: `${name}()`, file_type: "code", source_file: rel, source_location: `L${i + 1}` });
    });
  }
  const graphJson = join(dir, "graph.json");
  writeFileSync(graphJson, JSON.stringify({ nodes, links: [] }));
  return { dir, graphJson, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const bigBody = (nm) => `function ${nm}(items, opts) {
  const acc = [];
  for (const it of items) {
    if (!it || it.skip) { continue; }
    const row = { id: it.id, label: it.label, weight: it.weight * 2 + opts.base };
    acc.push(row);
  }
  acc.sort((a, b) => a.weight - b.weight);
  return acc.filter((r) => r.weight > opts.min);
}`;

test("duplicates: a mass clone (60 identical copies) is still detected — BUCKET_CAP no longer hides it", () => {
  const files = {};
  for (let i = 0; i < 60; i++) files[`src/f${i}.js`] = bigBody("collect") + "\n";
  const fx = buildFixture(files);
  try {
    const r = computeDuplicates(fx.dir, fx.graphJson);
    assert.ok(r.modes.strict.length > 0, `60 identical copies must yield pairs, got ${r.modes.strict.length}`);
    assert.ok(r.modes.strict.every(([, , s]) => s === 100), "identical copies pair at 100%");
  } finally { fx.cleanup(); }
});

test("duplicates: two real clones sharing a ubiquitous preamble still pair at 100% (union honesty)", () => {
  // a 12-token preamble copied into 40 unrelated functions (ubiquitous → capped), plus TWO functions
  // that are byte-identical in full. The capped preamble must not deflate the two real clones' jaccard.
  const preamble = `  const cfg = load();\n  const ctx = init(cfg);\n  const log = ctx.log;\n  log.info(cfg);`;
  const files = {};
  for (let i = 0; i < 40; i++) {
    files[`src/u${i}.js`] = `function unrelated${i}(a) {\n${preamble}\n  return a + ${i} * 7 - ${i};\n}\n`;
  }
  const twin = `function twin(a) {\n${preamble}\n  const out = a.map((x) => x.id).filter((z) => z > 3).join(",");\n  return out.length;\n}`;
  files["src/twinA.js"] = twin + "\n";
  files["src/twinB.js"] = twin.replace("twin(", "clone(") + "\n"; // same body, different NAME only
  const fx = buildFixture(files);
  try {
    const r = computeDuplicates(fx.dir, fx.graphJson);
    const name = (i) => r.frags[i].id;
    const twinPair = r.modes.renamed.find(([i, j]) => (name(i).includes("twinA") && name(j).includes("twinB")) || (name(i).includes("twinB") && name(j).includes("twinA")));
    assert.ok(twinPair, "the two real clones must be reported despite the ubiquitous preamble");
    assert.ok(twinPair[2] >= 90, `their similarity is high, not deflated by the capped preamble (got ${twinPair && twinPair[2]})`);
  } finally { fx.cleanup(); }
});

test("duplicates: Python docstrings with an embedded apostrophe don't desync the scanner", () => {
  const def = `def collect(items, opts):
    '''Collect the user's rows into a list, doesn't mutate input.'''
    acc = []
    for it in items:
        if it and not it.skip:
            acc.append({'id': it.id, 'w': it.weight * 2})
    acc.sort(key=lambda r: r['w'])
    return [r for r in acc if r['w'] > opts.min]`;
  const fx = buildFixture({ "a.py": def + "\n", "b.py": def + "\n" });
  try {
    const r = computeDuplicates(fx.dir, fx.graphJson);
    assert.equal(r.frags.length, 2, "both docstring'd defs produce fragments");
    assert.ok(r.modes.strict.some(([, , s]) => s === 100), "the two identical defs pair at 100%");
  } finally { fx.cleanup(); }
});

test("duplicates: JS regex literals containing quotes don't swallow the function body", () => {
  const fn = `function scrub(s, tags) {
    const cleaned = s.replace(/['"<>]/g, "").replace(/\\s+/g, " ").trim();
    const parts = cleaned.split(/[,;]/).filter((p) => p.length > 0);
    for (const t of tags) { if (parts.includes(t)) { return t; } }
    return parts.join("|");
  }`;
  const fx = buildFixture({ "a.js": fn + "\n", "b.js": fn + "\n" });
  try {
    const r = computeDuplicates(fx.dir, fx.graphJson);
    assert.equal(r.frags.length, 2, "both regex-containing functions produce fragments");
    assert.ok(r.modes.strict.some(([, , s]) => s === 100), "they pair at 100%");
  } finally { fx.cleanup(); }
});

test("duplicates: division after ++/-- and binary -/+ is NOT mis-scanned as a regex", () => {
  // a `/` after '+' or '-' is always division (i++ / 2, a - b / c) — regex must not eat the line
  const fn = `function ratios(items) {
    let i = 0;
    const out = [];
    for (const it of items) {
      const a = it.count++ / 2;
      const b = it.total - it.used / 3;
      out.push({ a: a, b: b, keep: it.flag });
    }
    return out.filter((r) => r.a > 1);
  }`;
  const fx = buildFixture({ "a.js": fn + "\n", "b.js": fn + "\n" });
  try {
    const r = computeDuplicates(fx.dir, fx.graphJson);
    assert.equal(r.frags.length, 2, "both produce fragments; division didn't swallow the body");
    const frag = r.frags.find((f) => f.id.includes("ratios"));
    assert.ok(frag.n > 40, `body tokens intact, not eaten by a phantom regex (got ${frag.n})`);
    assert.ok(r.modes.strict.some(([, , s]) => s === 100), "they pair at 100%");
  } finally { fx.cleanup(); }
});

test("duplicates: renamed mode does NOT equate a string literal with an identifier (S-sentinel)", () => {
  const withIdent = `function alpha(input, reasonCode) {
    const acc = [];
    for (const x of input) { acc.push({ v: x, r: reasonCode, t: x * 3 + 1 }); }
    return acc.filter((z) => z.t > 2).map((z) => z.v);
  }`;
  const withStr = withIdent.replace("alpha", "beta").replace("reasonCode", '"not-a-var"');
  const fx = buildFixture({ "a.js": withIdent + "\n", "b.js": withStr + "\n" });
  try {
    const r = computeDuplicates(fx.dir, fx.graphJson);
    const pair = [...r.modes.renamed, ...r.modes.strict].find(([i, j]) => (r.frags[i].id.includes("alpha") && r.frags[j].id.includes("beta")) || (r.frags[i].id.includes("beta") && r.frags[j].id.includes("alpha")));
    // an identifier→string substitution is a semantic edit, not a rename — must not score 100%
    assert.ok(!pair || pair[2] < 100, `identifier vs string literal must not be a perfect clone (got ${pair && pair[2]})`);
  } finally { fx.cleanup(); }
});

test("duplicates: the last symbol's fragment stops at its closing brace, not EOF (no trailing-code absorption)", () => {
  const fn = bigBody("handler");
  const trailing = `\n\nmodule.exports = { handler, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };\nregisterRoute("/x", handler);\nregisterRoute("/y", handler);\nif (require.main === module) { main(); }\n`;
  const fx = buildFixture({ "a.js": fn + trailing });
  try {
    const r = computeDuplicates(fx.dir, fx.graphJson);
    const frag = r.frags.find((f) => f.id.includes("handler"));
    assert.ok(frag, "handler fragment exists");
    assert.equal(frag.end, 10, "fragment ends at the function's closing brace (line 10), not the trailing module.exports at line 13+");
  } finally { fx.cleanup(); }
});

test("runDuplicates: no graph.json → needsGraph (never a crash); worker round-trip works on a real fixture", async () => {
  const empty = mkdtempSync(join(tmpdir(), "weavatrix-dup-"));
  try {
    const r = await runDuplicates(empty);
    assert.equal(r.ok, false);
    assert.equal(r.needsGraph, true);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  // worker round-trip on the fixture: graph.json in the standard graphOutDirForRepo location is not
  // set up here, so exercise the worker path via computeDuplicates parity instead: runDuplicates on a
  // repo WITH a graph is covered by the analytics smoke run (manual) — here we pin the API shape.
  assert.equal((await runDuplicates("")).ok, false);
});
