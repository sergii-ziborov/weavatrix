import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tOpenRepo, tSyncGraph } from "../src/mcp/tools-actions.mjs";
import { loadGraph } from "../src/mcp/graph-context.mjs";

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
  const graphPath = join(parent, "weavatrix-graphs", "target-repo", "graph.json");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(parent, "weavatrix-graphs", "target-repo"), { recursive: true });
  writeFileSync(graphPath, JSON.stringify({
    nodes: [{ id: "src/a.js", label: "a.js", source_file: "src/a.js" }],
    links: [],
    repoBoundaryV: 1,
    edgeTypesV: 2,
  }));
  const ctx = {
    repoRoot: parent,
    graphPath: join(parent, "old.json"),
    reload() { return loadGraph(this.graphPath); },
  };
  try {
    const out = await tOpenRepo(null, { path: repo, build: false }, ctx);
    assert.match(out, /Opened .*target-repo/);
    assert.equal(ctx.repoRoot, realpathSync.native(repo));
    assert.equal(ctx.graphPath, join(realpathSync.native(parent), "weavatrix-graphs", "target-repo", "graph.json"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("sync_graph: requires one rebuild for graphs created before boundary hardening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-sync-old-"));
  const graphPath = join(dir, "graph.json");
  writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [], repoBoundaryV: 0 }));
  const previousUrl = process.env.WEAVATRIX_SYNC_URL;
  const previousFetch = globalThis.fetch;
  let fetched = false;
  process.env.WEAVATRIX_SYNC_URL = "https://sync.invalid/upload";
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    const out = await tSyncGraph({ nodes: [], links: [], repoBoundaryV: 1 }, {}, { graphPath, repoRoot: dir });
    assert.match(out, /predates repository-boundary hardening/);
    assert.equal(fetched, false);
  } finally {
    if (previousUrl == null) delete process.env.WEAVATRIX_SYNC_URL;
    else process.env.WEAVATRIX_SYNC_URL = previousUrl;
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync_graph: requires compile-only edge metadata before upload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-sync-untyped-"));
  const graphPath = join(dir, "graph.json");
  writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [], repoBoundaryV: 1 }));
  const previousUrl = process.env.WEAVATRIX_SYNC_URL;
  const previousFetch = globalThis.fetch;
  let fetched = false;
  process.env.WEAVATRIX_SYNC_URL = "https://sync.invalid/upload";
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    const out = await tSyncGraph(loadGraph(graphPath), {}, { graphPath, repoRoot: dir });
    assert.match(out, /predates compile-only edge metadata/);
    assert.equal(fetched, false);
  } finally {
    if (previousUrl == null) delete process.env.WEAVATRIX_SYNC_URL;
    else process.env.WEAVATRIX_SYNC_URL = previousUrl;
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync_graph: uploads only the versioned metadata allowlist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-sync-safe-"));
  const graphPath = join(dir, "graph.json");
  const secret = "PRIVATE_SOURCE_BODY_9f4c";
  writeFileSync(graphPath, JSON.stringify({
    repoBoundaryV: 1,
    edgeTypesV: 2,
    extImportsV: 2,
    complexityV: 1,
    injectedSource: secret,
    nodes: [{
      id: "src/a.js#run@1", label: "run()", file_type: "code", source_file: "src/a.js",
      source_location: "L1", source_end: "L3", community: 0, exported: true,
      source_text: secret,
      complexity: { startLine: 1, endLine: 3, cyclomatic: 2, confidence: "medium", evidence: [secret], source: secret },
    }, {
      id: "C:/Users/Alice/private.js#leak@1", source_file: "C:/Users/Alice/private.js",
    }, {
      id: "../outside.js#leak@1", source_file: "../outside.js",
    }],
    links: [
      { source: "src/a.js", target: "src/a.js#run@1", relation: "imports", confidence: "EXTRACTED", compileOnly: true, line: 2, specifier: "crate::types", source_text: secret },
      { source: "/home/alice/private.js", target: "src/a.js", relation: "imports" },
      { source: "src/a.js", target: "..\\outside.js#leak@1", relation: "references" },
    ],
    externalImports: [
      { file: "src/a.js", spec: "node:fs", pkg: "fs", builtin: true, kind: "esm", line: 1, source_text: secret },
      { file: "\\\\server\\share\\private.js", spec: "private-package" },
      { file: "src/../../outside.js", spec: "private-package" },
    ],
  }));
  const previousUrl = process.env.WEAVATRIX_SYNC_URL;
  const previousFetch = globalThis.fetch;
  let sent;
  process.env.WEAVATRIX_SYNC_URL = "https://sync.invalid/upload";
  globalThis.fetch = async (_url, options) => { sent = options; return { ok: true, status: 200 }; };
  try {
    const graph = loadGraph(graphPath);
    const out = await tSyncGraph(graph, {}, { graphPath, repoRoot: dir });
    assert.match(out, /pushed to/);
    assert.ok(sent);
    assert.equal(sent.headers["content-type"], "application/json");
    assert.equal(sent.body.includes(secret), false, "raw or nested injected source must not leave the machine");
    const payload = JSON.parse(sent.body);
    assert.equal(payload.syncPayloadV, 2);
    assert.equal(payload.edgeTypesV, 2);
    assert.deepEqual(Object.keys(payload).sort(), ["complexityV", "edgeTypesV", "extImportsV", "externalImports", "links", "nodes", "repoBoundaryV", "syncPayloadV"]);
    assert.deepEqual(payload.links[0], { source: "src/a.js", target: "src/a.js#run@1", relation: "imports", confidence: "EXTRACTED", compileOnly: true, line: 2, specifier: "crate::types" });
    assert.equal(payload.links.length, 1, "absolute and traversing graph IDs must not leave the machine");
    assert.equal(payload.nodes.length, 1, "nodes with absolute or traversing IDs must be dropped");
    assert.equal(payload.nodes[0].id, "src/a.js#run@1", "valid relative symbol IDs stay intact");
    assert.equal(payload.externalImports.length, 1, "absolute and traversing source paths must be dropped");
    assert.equal(sent.headers["x-weavatrix-payload-version"], "2");
    assert.deepEqual(payload.nodes[0].complexity, { startLine: 1, endLine: 3, cyclomatic: 2, confidence: "medium" });
    assert.equal(payload.nodes[0].source_text, undefined);
    assert.equal(payload.externalImports[0].source_text, undefined);
  } finally {
    if (previousUrl == null) delete process.env.WEAVATRIX_SYNC_URL;
    else process.env.WEAVATRIX_SYNC_URL = previousUrl;
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadGraph preserves the repository-boundary marker for sync_graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-load-graph-"));
  const graphPath = join(dir, "graph.json");
  writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [], repoBoundaryV: 1 }));
  try {
    assert.equal(loadGraph(graphPath).repoBoundaryV, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("open_repo: build:false refuses a legacy edge-schema graph without changing target", async () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-open-legacy-"));
  const repo = join(parent, "legacy-repo");
  const graphPath = join(parent, "weavatrix-graphs", "legacy-repo", "graph.json");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(parent, "weavatrix-graphs", "legacy-repo"), { recursive: true });
  writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [], repoBoundaryV: 1 }));
  const ctx = { repoRoot: parent, graphPath: join(parent, "current.json"), reload() { throw new Error("must not reload"); } };
  try {
    const out = await tOpenRepo(null, { path: repo, build: false }, ctx);
    assert.match(out, /predates compile-only edge metadata/);
    assert.equal(ctx.repoRoot, parent);
    assert.equal(ctx.graphPath, join(parent, "current.json"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
