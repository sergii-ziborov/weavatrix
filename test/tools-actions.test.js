import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tOpenRepo, tPreviewSyncGraph, tPullArchitectureContract, tSyncGraph } from "../src/mcp/tools-actions.mjs";
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

const confirmationFrom = (preview) => {
  const match = /confirm_token: "([a-f0-9]{24})"/.exec(preview);
  assert.ok(match, `missing confirmation token in preview:\n${preview}`);
  return match[1];
};

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
    extractorSchemaV: 5,
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
    const explicitPreview = await tPreviewSyncGraph(graph, { payload_version: 2 }, { graphPath, repoRoot: dir });
    assert.equal(explicitPreview.result.networkRequestMade, false);
    assert.equal(explicitPreview.result.payloadVersion, 2);
    assert.match(explicitPreview.text, /SYNC PREVIEW.*no network request was made/);
    const preview = await tSyncGraph(graph, { payload_version: 2 }, { graphPath, repoRoot: dir });
    assert.match(preview, /SYNC PREVIEW.*no network request was made/);
    assert.match(preview, /Destination: https:\/\/sync\.invalid\/upload/);
    assert.match(preview, /opaque repository UUID/);
    assert.match(preview, /Payload fields: .*nodes/);
    assert.equal(sent, undefined, "preview must not perform a request");
    const token = confirmationFrom(preview);
    const stillDry = await tSyncGraph(graph, { payload_version: 2, confirm_token: token }, { graphPath, repoRoot: dir });
    assert.match(stillDry, /dry_run is still true; no network request was made/);
    assert.equal(sent, undefined, "a token alone is insufficient while dry_run defaults true");
    const out = await tSyncGraph(graph, { payload_version: 2, dry_run: false, confirm_token: token }, { graphPath, repoRoot: dir });
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

test("open_repo: build:false refuses an explicit build-mode mismatch without retargeting", async () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-open-mode-"));
  const repo = join(parent, "target-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const graphPath = join(graphOutDirForRepo(realpathSync.native(repo)), "graph.json");
  mkdirSync(graphOutDirForRepo(realpathSync.native(repo)), { recursive: true });
  writeFileSync(graphPath, JSON.stringify({
    nodes: [], links: [], repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, extractorSchemaV: 5,
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

test("sync_graph: payload v3 derives and uploads a bounded evidence snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-sync-evidence-"));
  const graphPath = join(dir, "graph.json");
  const secret = "PRIVATE_SOURCE_BODY_v3_7b12";
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export function run() { return 1 }\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(graphPath, JSON.stringify({
    repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, extImportsV: 2, complexityV: 1,
    nodes: [
      { id: "src/a.js", file_type: "code", source_file: "src/a.js" },
      { id: "src/a.js#run@1", label: "run()", file_type: "code", source_file: "src/a.js", source_text: secret,
        complexity: { startLine: 1, endLine: 350, loc: 350, cyclomatic: 2, params: 0, evidence: [secret] } },
    ],
    links: [{ source: "src/a.js", target: "src/a.js#run@1", relation: "contains", provenance: "EXTRACTED" }],
    externalImports: [],
  }));
  const previousUrl = process.env.WEAVATRIX_SYNC_URL;
  const previousFetch = globalThis.fetch;
  let sent;
  process.env.WEAVATRIX_SYNC_URL = "https://sync.invalid/upload";
  globalThis.fetch = async (_url, options) => {
    sent = options;
    return { ok: true, status: 200, headers: { get: () => null } };
  };
  try {
    const graph = loadGraph(graphPath);
    const preview = await tSyncGraph(graph, {}, { graphPath, repoRoot: dir });
    assert.match(preview, /Payload V3/);
    assert.match(preview, /Excluded by the wire allowlist/);
    assert.equal(sent, undefined);
    const out = await tSyncGraph(graph, {dry_run: false, confirm_token: confirmationFrom(preview)}, { graphPath, repoRoot: dir });
    assert.match(out, /evidence [a-f0-9]{12}/);
    const payload = JSON.parse(sent.body);
    assert.equal(payload.syncPayloadV, 3);
    assert.equal(payload.evidenceV, 1);
    assert.match(payload.evidence.snapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(payload.evidence.sections.health.checks.osv, "NOT_CHECKED");
    assert.equal(payload.evidence.sections.health.verdict, "FAIL");
    assert.equal(payload.evidence.sections.health.complexity.hotspots[0].file, "src/a.js");
    assert.equal(sent.headers["x-weavatrix-payload-version"], "3");
    assert.equal(sent.body.includes(secret), false);
    assert.equal(sent.body.includes(dir.replace(/\\/g, "/")), false);
  } finally {
    if (previousUrl == null) delete process.env.WEAVATRIX_SYNC_URL;
    else process.env.WEAVATRIX_SYNC_URL = previousUrl;
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync_graph: rejects non-loopback HTTP and never fetches with a wrong confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-sync-confirm-"));
  const graphPath = join(dir, "graph.json");
  writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, nodes: [], links: []}));
  const previousUrl = process.env.WEAVATRIX_SYNC_URL;
  const previousFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    process.env.WEAVATRIX_SYNC_URL = "http://example.com/upload";
    assert.match(await tSyncGraph(loadGraph(graphPath), {payload_version: 2}, {graphPath, repoRoot: dir}), /must use HTTPS unless the destination is loopback/);
    process.env.WEAVATRIX_SYNC_URL = "https://sync.invalid/upload?tenant=private";
    const preview = await tSyncGraph(loadGraph(graphPath), {payload_version: 2, confirm_token: "bad-token"}, {graphPath, repoRoot: dir});
    assert.match(preview, /missing, expired, or did not match/);
    assert.match(preview, /query redacted/);
    assert.doesNotMatch(preview, /tenant=private/);
    assert.equal(fetched, false);
  } finally {
    if (previousUrl == null) delete process.env.WEAVATRIX_SYNC_URL;
    else process.env.WEAVATRIX_SYNC_URL = previousUrl;
    globalThis.fetch = previousFetch;
    rmSync(dir, {recursive: true, force: true});
  }
});

test("pull_architecture_contract: distinguishes an unregistered repository from a missing endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-contract-not-found-"));
  const graphPath = join(dir, "graph.json");
  writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, nodes: [], links: []}));
  const previousUrl = process.env.WEAVATRIX_SYNC_URL;
  const previousToken = process.env.WEAVATRIX_SYNC_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.WEAVATRIX_SYNC_URL = "https://sync.invalid/upload";
  process.env.WEAVATRIX_SYNC_TOKEN = "test-token";
  globalThis.fetch = async () => ({ok: false, status: 404, json: async () => ({state: "NOT_FOUND"})});
  try {
    const result = await tPullArchitectureContract(loadGraph(graphPath), {}, {graphPath, repoRoot: dir});
    assert.equal(result.result.state, "REPOSITORY_NOT_REGISTERED");
    assert.equal(result.result.httpStatus, 404);
    assert.match(result.text, /has not completed a preview-confirmed repository sync/);
  } finally {
    if (previousUrl == null) delete process.env.WEAVATRIX_SYNC_URL;
    else process.env.WEAVATRIX_SYNC_URL = previousUrl;
    if (previousToken == null) delete process.env.WEAVATRIX_SYNC_TOKEN;
    else process.env.WEAVATRIX_SYNC_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
    rmSync(dir, {recursive: true, force: true});
  }
});

test("pull_architecture_contract: refuses bearer auth over non-loopback HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-contract-insecure-"));
  const graphPath = join(dir, "graph.json");
  writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, nodes: [], links: []}));
  const previousUrl = process.env.WEAVATRIX_SYNC_URL;
  const previousToken = process.env.WEAVATRIX_SYNC_TOKEN;
  const previousArchitectureUrl = process.env.WEAVATRIX_ARCHITECTURE_URL;
  const previousFetch = globalThis.fetch;
  let fetched = false;
  process.env.WEAVATRIX_SYNC_URL = "https://sync.invalid/upload";
  process.env.WEAVATRIX_ARCHITECTURE_URL = "http://example.com/contract";
  process.env.WEAVATRIX_SYNC_TOKEN = "test-token";
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    const result = await tPullArchitectureContract(loadGraph(graphPath), {}, {graphPath, repoRoot: dir});
    assert.match(result, /must use HTTPS unless the destination is loopback/);
    assert.equal(fetched, false);
  } finally {
    if (previousUrl == null) delete process.env.WEAVATRIX_SYNC_URL;
    else process.env.WEAVATRIX_SYNC_URL = previousUrl;
    if (previousToken == null) delete process.env.WEAVATRIX_SYNC_TOKEN;
    else process.env.WEAVATRIX_SYNC_TOKEN = previousToken;
    if (previousArchitectureUrl == null) delete process.env.WEAVATRIX_ARCHITECTURE_URL;
    else process.env.WEAVATRIX_ARCHITECTURE_URL = previousArchitectureUrl;
    globalThis.fetch = previousFetch;
    rmSync(dir, {recursive: true, force: true});
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
  mkdirSync(join(repo, ".git"), { recursive: true });
  const graphPath = join(graphOutDirForRepo(realpathSync.native(repo)), "graph.json");
  mkdirSync(graphOutDirForRepo(realpathSync.native(repo)), { recursive: true });
  writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [], repoBoundaryV: 1 }));
  const ctx = { repoRoot: parent, graphPath: join(parent, "current.json"), reload() { throw new Error("must not reload"); } };
  try {
    const out = await tOpenRepo(null, { path: repo, build: false }, ctx);
    assert.match(out, /predates current typed-edge\/provenance metadata/);
    assert.equal(ctx.repoRoot, parent);
    assert.equal(ctx.graphPath, join(parent, "current.json"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
