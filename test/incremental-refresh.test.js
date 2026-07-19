import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInternalGraph, writeInternalGraph } from "../src/graph/internal-builder.js";
import { jsExportSignature, refreshGraphIncrementally, snapshotRepository } from "../src/graph/incremental-refresh.js";

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-incremental-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const parseTrackingBuilder = (parsed) => (repoDir, options = {}) => buildInternalGraph(repoDir, {
  ...options,
  onParseFile: (file) => parsed.push(file),
});

test("export signatures ignore implementation bodies but include every exported binding", () => {
  assert.equal(
    jsExportSignature("export function value(){ return 1; }", "value.ts"),
    jsExportSignature("export function value(){ return 2; }", "value.ts"),
  );
  assert.notEqual(
    jsExportSignature("export const a = 1;", "value.ts"),
    jsExportSignature("export const a = 1, b = 2;", "value.ts"),
  );
});

test("incremental refresh returns none without invoking the parser when content is unchanged", async () => {
  const dir = repoWith({ "src/a.ts": "export function a(){ return 1; }\n" });
  try {
    const baseline = await buildInternalGraph(dir);
    const parsed = [];
    const result = await refreshGraphIncrementally(dir, baseline, { buildGraph: parseTrackingBuilder(parsed) });
    assert.equal(result.kind, "none");
    assert.equal(result.graph, baseline);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(parsed, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("incremental refresh reparses one edited file plus bounded reverse importers and keeps a complete graph", async () => {
  const dir = repoWith({
    "src/value.ts": "export function value(){ return 1; }\n",
    "src/use.ts": "import { value } from './value';\nexport function use(){ return value(); }\n",
    "src/unrelated.ts": "export function unrelated(){ return 3; }\n",
  });
  try {
    const baseline = await buildInternalGraph(dir);
    writeFileSync(join(dir, "src/value.ts"), "export function value(){ const next = 2; return next; }\n");
    const parsed = [];
    const result = await refreshGraphIncrementally(dir, baseline, { buildGraph: parseTrackingBuilder(parsed) });

    assert.equal(result.kind, "incremental");
    assert.deepEqual(result.changedFiles, ["src/value.ts"]);
    assert.deepEqual(result.parsedFiles, ["src/use.ts", "src/value.ts"]);
    assert.deepEqual([...new Set(parsed)].sort(), result.parsedFiles);
    assert.ok(!parsed.includes("src/unrelated.ts"), "unrelated source is reused, not reparsed");
    assert.notEqual(result.revision, baseline.graphRevision);
    assert.equal(result.graph.nodes.filter((node) => !String(node.id).includes("#")).length, 3, "scoped result was merged into the full file universe");
    assert.equal(result.graph.barrelResolutionV, baseline.barrelResolutionV);
    assert.equal(result.graph.edgeTypesV, baseline.edgeTypesV);
    assert.equal(result.graph.edgeProvenanceV, baseline.edgeProvenanceV);
    assert.equal(result.graph.physicalFileLocV, 1);
    assert.equal(result.graph.nodes.find((node) => node.id === "src/value.ts")?.physical_loc, 1,
      "incremental merges preserve fresh physical file LOC metadata");
    const ids = new Set(result.graph.nodes.map((node) => String(node.id)));
    assert.ok(result.graph.links.every((link) => ids.has(String(link.source)) && ids.has(String(link.target))), "merged graph has no dangling endpoints");
    const value = result.graph.nodes.find((node) => node.source_file === "src/value.ts" && String(node.id).includes("#value@"));
    const use = result.graph.nodes.find((node) => node.source_file === "src/use.ts" && String(node.id).includes("#use@"));
    assert.ok(result.graph.links.some((link) => link.source === use.id && link.target === value.id && link.relation === "calls"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("incremental refresh preserves incoming edges from files outside the one-hop reparse set", async () => {
  const dir = repoWith({
    "src/c.ts": "export function c(){ return 1; }\n",
    "src/b.ts": "import { c } from './c';\nexport function b(){ return c(); }\n",
    "src/a.ts": "import { b } from './b';\nexport function a(){ return b(); }\n",
  });
  try {
    const baseline = await buildInternalGraph(dir);
    writeFileSync(join(dir, "src/c.ts"), "export function c(){ const next = 2; return next; }\n");
    const result = await refreshGraphIncrementally(dir, baseline);

    assert.equal(result.kind, "incremental");
    assert.deepEqual(result.parsedFiles, ["src/b.ts", "src/c.ts"]);
    const a = result.graph.nodes.find((node) => node.source_file === "src/a.ts" && String(node.id).includes("#a@"));
    const b = result.graph.nodes.find((node) => node.source_file === "src/b.ts" && String(node.id).includes("#b@"));
    const c = result.graph.nodes.find((node) => node.source_file === "src/c.ts" && String(node.id).includes("#c@"));
    assert.ok(result.graph.links.some((link) => link.source === a.id && link.target === b.id && link.relation === "calls"), "A -> B survives even though A was not reparsed");
    assert.ok(result.graph.links.some((link) => link.source === b.id && link.target === c.id && link.relation === "calls"), "B -> C is regenerated by the scoped parse");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("incremental refresh preserves deterministic communities across unrelated territories", async () => {
  const dir = repoWith({
    "src/alpha/a.ts": "export function a(){ return 1; }\n",
    "src/zeta/z.ts": "export function z(){ return 2; }\n",
  });
  try {
    const baseline = await buildInternalGraph(dir);
    const baselineAlpha = baseline.nodes.find((node) => node.source_file === "src/alpha/a.ts")?.community;
    const baselineZeta = baseline.nodes.find((node) => node.source_file === "src/zeta/z.ts")?.community;
    assert.notEqual(baselineAlpha, baselineZeta);

    writeFileSync(join(dir, "src/zeta/z.ts"), "export function z(){ const next = 3; return next; }\n");
    const result = await refreshGraphIncrementally(dir, baseline);

    assert.equal(result.kind, "incremental");
    assert.deepEqual(result.parsedFiles, ["src/zeta/z.ts"]);
    const alpha = result.graph.nodes.find((node) => node.source_file === "src/alpha/a.ts")?.community;
    const zeta = result.graph.nodes.find((node) => node.source_file === "src/zeta/z.ts")?.community;
    assert.equal(alpha, baselineAlpha);
    assert.equal(zeta, baselineZeta);
    assert.notEqual(alpha, zeta, "a scoped rebuild cannot collapse the edited territory into community zero");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("incremental snapshot never follows a control-file symlink outside the repository", (t) => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-incremental-boundary-"));
  const repo = join(root, "repo");
  const secret = join(root, "outside-secret.txt");
  mkdirSync(repo);
  writeFileSync(join(repo, "source.js"), "export const value = 1;\n");
  writeFileSync(secret, "first secret");
  try {
    try { symlinkSync(secret, join(repo, ".weavatrixignore"), "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) { t.skip("file symlinks are unavailable on this Windows host"); return; }
      throw error;
    }
    const before = snapshotRepository(repo);
    writeFileSync(secret, "different outside secret");
    const after = snapshotRepository(repo);
    assert.equal(before.controlHashes[".weavatrixignore"], "UNREADABLE:escape");
    assert.equal(after.controlHashes[".weavatrixignore"], "UNREADABLE:escape");
    assert.equal(before.revision, after.revision, "outside content cannot become a graph freshness oracle");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("incremental refresh falls back to a full build after deletion", async () => {
  const dir = repoWith({
    "src/a.ts": "export function a(){ return 1; }\n",
    "src/b.ts": "export function b(){ return 2; }\n",
  });
  try {
    const baseline = await buildInternalGraph(dir);
    unlinkSync(join(dir, "src/b.ts"));
    const result = await refreshGraphIncrementally(dir, baseline);
    assert.equal(result.kind, "full");
    assert.equal(result.reason, "file-universe-changed");
    assert.deepEqual(result.changedFiles, ["src/b.ts"]);
    assert.ok(!result.graph.nodes.some((node) => node.source_file === "src/b.ts"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("incremental refresh falls back to full for alias/config changes", async () => {
  const dir = repoWith({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    "src/a.ts": "export function a(){ return 1; }\n",
  });
  try {
    const baseline = await buildInternalGraph(dir);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["app/*"] } } }));
    const result = await refreshGraphIncrementally(dir, baseline);
    assert.equal(result.kind, "full");
    assert.equal(result.reason, "config-manifest-or-alias-changed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("incremental refresh falls back to full when a barrel file changes", async () => {
  const dir = repoWith({
    "src/value.ts": "export function value(){ return 1; }\n",
    "src/index.ts": "export * from './value';\n",
    "src/use.ts": "import { value } from './index';\nexport function use(){ return value(); }\n",
  });
  try {
    const baseline = await buildInternalGraph(dir);
    writeFileSync(join(dir, "src/index.ts"), "// facade comment\nexport * from './value';\n");
    const result = await refreshGraphIncrementally(dir, baseline);
    assert.equal(result.kind, "full");
    assert.equal(result.reason, "barrel-file-changed:src/index.ts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scoped internal graphs cannot be written as complete graph files", async () => {
  const dir = repoWith({ "src/a.ts": "export function a(){ return 1; }\n" });
  try {
    await assert.rejects(
      writeInternalGraph(dir, join(dir, "graph.json"), { includeFiles: ["src/a.ts"] }),
      /refusing to write a scoped incremental graph/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
