import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { computeDuplicates, runDuplicates } from "../src/analysis/duplicates.js";
import { tFindDuplicates } from "../src/mcp/tools-health.mjs";
import { compareDuplicateGroups, isDeclarativeCatalogCloneGroup, isFrameworkBoilerplateCloneGroup } from "../src/analysis/duplicate-groups.js";

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

test("duplicates: conventional router-only groups are recognized as framework boilerplate", () => {
  assert.equal(isFrameworkBoilerplateCloneGroup({members: [
    {file: "services/auth/auth.router.js", label: "router"},
    {file: "services/attack/attack.router.js", label: "router"},
  ]}), true);
  assert.equal(isFrameworkBoilerplateCloneGroup({members: [
    {file: "services/auth/auth.router.js", label: "router"},
    {file: "services/attack/attack.controller.js", label: "startMitigate()"},
  ]}), false);
});

test("duplicates: immutable declarative catalogs are reviewable data shapes, not executable clones", () => {
  assert.equal(isDeclarativeCatalogCloneGroup({members: [{declarative: true}, {declarative: true}]}), true);
  assert.equal(isDeclarativeCatalogCloneGroup({members: [{declarative: true}, {declarative: false}]}), false);
});

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

test("duplicates: same-key policy tables with different numeric limits are not clones", () => {
  const table = (name, prefix, offset) => `const ${name} = Object.freeze({\n` +
    Array.from({ length: 40 }, (_, i) => `  ${prefix}_${i}: ${offset + i * 7},`).join("\n") + "\n});\n";
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-numeric-"));
  const files = {
    "src/http-limits.js": table("HTTP_LIMITS", "ROUTE_LIMIT", 100),
    "src/default-limits.js": table("DEFAULT_LIMITS", "ROUTE_LIMIT", 10_000),
  };
  const nodes = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    nodes.push({ id: rel, label: rel.split("/").pop(), file_type: "code", source_file: rel, source_location: "L1" });
    nodes.push({ id: `${rel}#table@1`, label: "table", file_type: "code", source_file: rel, source_location: "L1" });
  }
  const graphJson = join(dir, "graph.json");
  writeFileSync(graphJson, JSON.stringify({ nodes, links: [] }));
  try {
    const result = computeDuplicates(dir, graphJson);
    const name = (i) => result.frags[i].file;
    const pair = result.modes.renamed.find(([i, j]) => [name(i), name(j)].sort().join("+") === "src/default-limits.js+src/http-limits.js");
    assert.ok(!pair, "different numeric constants remain semantic differences");
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
