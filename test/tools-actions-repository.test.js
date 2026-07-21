import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tOpenRepo } from "../src/mcp/tools-actions.mjs";
import { loadGraph } from "../src/mcp/graph-context.mjs";
import { graphOutDirForRepo } from "../src/graph/layout.js";

const previousGraphHome = process.env.WEAVATRIX_GRAPH_HOME;
const testGraphHome = mkdtempSync(join(tmpdir(), "wx-graph-home-"));
process.env.WEAVATRIX_GRAPH_HOME = testGraphHome;
after(() => {
  if (previousGraphHome == null) delete process.env.WEAVATRIX_GRAPH_HOME;
  else process.env.WEAVATRIX_GRAPH_HOME = previousGraphHome;
  rmSync(testGraphHome, { recursive: true, force: true });
});

test("open_repo: rejects relative paths before retargeting", async () => {
  const out = await tOpenRepo(null, { path: "../another-repo" }, {});
  assert.match(out, /requires an absolute repository path/);
});

test("open_repo: rejects a file instead of treating it as a repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-open-repo-"));
  const file = join(dir, "not-a-repo.txt");
  writeFileSync(file, "not a directory\n");
  try {
    const out = await tOpenRepo(null, { path: file }, {});
    assert.match(out, /Not a directory/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("open_repo: rejects an ordinary directory that is not a Git working tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-open-repo-"));
  try {
    const out = await tOpenRepo(null, { path: dir }, {});
    assert.match(out, /Not a Git repository/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("open_repo: switches to another Git repository with an existing graph in one call", async () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-open-switch-"));
  const repo = join(parent, "target-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const graphPath = join(graphOutDirForRepo(realpathSync.native(repo)), "graph.json");
  mkdirSync(graphOutDirForRepo(realpathSync.native(repo)), { recursive: true });
  writeFileSync(graphPath, JSON.stringify({
    nodes: [{ id: "src/a.js", label: "a.js", source_file: "src/a.js" }],
    links: [],
    repoBoundaryV: 1,
    edgeTypesV: 2,
    edgeProvenanceV: 1,
    physicalFileLocV: 1,
    extractorSchemaV: 7,
    reExportOccurrencesV: 1,
    symbolSpacesV: 1,
    graphPrecisionMode: "off",
  }));
  const ctx = {
    repoRoot: parent,
    graphPath: join(parent, "old.json"),
    reload() { return loadGraph(this.graphPath); },
  };
  try {
    const out = await tOpenRepo(null, { path: repo, build: false }, ctx);
    assert.match(out, /Opened .*target-repo/);
    assert.match(out, /Build mode: full/);
    assert.equal(ctx.repoRoot, realpathSync.native(repo));
    assert.equal(ctx.graphPath, join(graphOutDirForRepo(realpathSync.native(repo)), "graph.json"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("open_repo: build:false refuses an explicit build-mode mismatch without retargeting", async () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-open-mode-"));
  const repo = join(parent, "target-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const graphPath = join(graphOutDirForRepo(realpathSync.native(repo)), "graph.json");
  mkdirSync(graphOutDirForRepo(realpathSync.native(repo)), { recursive: true });
  writeFileSync(graphPath, JSON.stringify({
    nodes: [], links: [], repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, physicalFileLocV: 1, extractorSchemaV: 7,
    reExportOccurrencesV: 1, symbolSpacesV: 1, graphPrecisionMode: "off",
    graphBuildMode: "full",
  }));
  const ctx = { repoRoot: parent, graphPath: join(parent, "current.json"), reload() { throw new Error("must not reload"); } };
  try {
    const out = await tOpenRepo(null, { path: repo, mode: "no-tests", build: false }, ctx);
    assert.match(out, /built in full, but no-tests was requested/);
    assert.equal(ctx.repoRoot, parent);
    assert.equal(ctx.graphPath, join(parent, "current.json"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("open_repo: build:false refuses a legacy graph schema without changing target", async () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-open-legacy-"));
  const repo = join(parent, "legacy-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const graphPath = join(graphOutDirForRepo(realpathSync.native(repo)), "graph.json");
  mkdirSync(graphOutDirForRepo(realpathSync.native(repo)), { recursive: true });
  writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [], repoBoundaryV: 1 }));
  const ctx = { repoRoot: parent, graphPath: join(parent, "current.json"), reload() { throw new Error("must not reload"); } };
  try {
    const out = await tOpenRepo(null, { path: repo, build: false }, ctx);
    assert.match(out, /predates current graph metadata/);
    assert.equal(ctx.repoRoot, parent);
    assert.equal(ctx.graphPath, join(parent, "current.json"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
