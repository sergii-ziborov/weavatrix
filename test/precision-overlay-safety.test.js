import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildLspPrecisionOverlay,
  invalidatePrecisionOverlay,
  mergePrecisionOverlay,
  PRECISION_OVERLAY_V,
  precisionOverlayMatches,
  precisionSemanticInputsMatch,
} from "../src/precision/lsp-overlay.js";
import { computeDeadCodeReview } from "../src/analysis/dead-code-review.js";
import { buildInternalGraph } from "../src/graph/internal-builder.js";
import { snapshotRepository } from "../src/graph/incremental-refresh.js";
import { typeScriptLspContract } from "../src/precision/typescript-lsp-provider.js";
import { loadGraph } from "../src/mcp/graph-context.mjs";
import {fileNode, fixtureGraph, makeRepo, symbolNode, withSnapshot} from './helpers/precision-overlay-fixtures.js'

test("an empty result is not a no-reference proof when the configured project misses a graph file", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-config-coverage-"));
  mkdirSync(join(root, "src"), {recursive: true});
  mkdirSync(join(root, "scripts"), {recursive: true});
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({include: ["src/**/*.ts"]}));
  writeFileSync(join(root, "src", "target.ts"), "function target() {}\n");
  writeFileSync(join(root, "scripts", "caller.ts"), "function caller() { return target(); }\n");
  const target = symbolNode("src/target.ts", "target", 1, 1, {visibility: "private"});
  const caller = symbolNode("scripts/caller.ts", "caller", 1, 1, {exported: true});
  const graph = withSnapshot(root, {
    graphRevision: "revision-config-coverage",
    graphBuildMode: "full",
    nodes: [fileNode("src/target.ts"), fileNode("scripts/caller.ts"), target, caller],
    links: [
      {source: "src/target.ts", target: target.id, relation: "contains", provenance: "EXTRACTED"},
      {source: "scripts/caller.ts", target: caller.id, relation: "contains", provenance: "EXTRACTED"},
      {source: caller.id, target: target.id, relation: "calls", line: 1, provenance: "INFERRED"},
    ],
  });
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => ({async openDocument() {}, async references() { return []; }, async close() {}}),
    });
    assert.equal(overlay.state, "COMPLETE", JSON.stringify(overlay));
    assert.deepEqual(overlay.noReferenceSymbols, []);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("a changed source hash fails closed before didOpen", async () => {
  const root = makeRepo();
  const graph = withSnapshot(root, fixtureGraph());
  writeFileSync(join(root, "src", "target.ts"), "export function target() { return 1; }\n");
  let opened = 0;
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => ({
        async openDocument() { opened++; },
        async references() { return []; },
        async close() {},
      }),
    });
    assert.equal(opened, 0);
    assert.equal(overlay.state, "PARTIAL");
    assert.equal(overlay.coverage.verifiedEdges, 0);
    assert.deepEqual(overlay.links, []);
    assert.deepEqual(overlay.noReferenceSymbols, []);
    assert.match(overlay.reason, /graph snapshot/i);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("reference caps and the global deadline report PARTIAL instead of COMPLETE", async () => {
  const root = makeRepo();
  const graph = withSnapshot(root, fixtureGraph());
  const location = (file) => ({
    uri: pathToFileURL(join(root, file)).href,
    range: {start: {line: 1, character: 9}, end: {line: 1, character: 15}},
  });
  try {
    const capped = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      maxReferences: 1,
      clientFactory: async () => ({
        async openDocument() {},
        async references() { return [location("src/caller.ts"), location("src/decoy.ts")]; },
        async close() {},
      }),
    });
    assert.equal(capped.state, "PARTIAL");
    assert.equal(capped.coverage.references, 1);
    assert.equal(capped.coverage.truncated, true);

    let killed = false;
    const started = Date.now();
    const deadline = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      timeoutMs: 100,
      clientFactory: async () => ({
        async openDocument() {},
        references() { return new Promise(() => {}); },
        async close() {},
        kill() { killed = true; },
      }),
    });
    assert.equal(deadline.state, "PARTIAL");
    assert.equal(deadline.coverage.truncated, true);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(killed, true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("PARTIAL overlays are retried and COMPLETE cache reuse requires the same request contract", async () => {
  const root = makeRepo();
  const graph = withSnapshot(root, fixtureGraph());
  const cacheDirectory = join(root, ".weavatrix-test");
  mkdirSync(cacheDirectory, {recursive: true});
  const graphPath = join(cacheDirectory, "graph.json");
  let factories = 0;
  const location = [{
    uri: pathToFileURL(join(root, "src", "caller.ts")).href,
    range: {start: {line: 1, character: 9}, end: {line: 1, character: 15}},
  }];
  const clientFactory = async () => {
    factories++;
    const attempt = factories;
    return {
      async openDocument() {},
      async references() {
        if (attempt === 1) throw new Error("synthetic provider failure");
        return location;
      },
      async close() {},
    };
  };
  try {
    const partial = await buildLspPrecisionOverlay({repoRoot: root, graph, graphPath, maxSymbols: 4, clientFactory});
    assert.equal(partial.state, "PARTIAL");
    const complete = await buildLspPrecisionOverlay({repoRoot: root, graph, graphPath, maxSymbols: 4, clientFactory});
    assert.equal(complete.state, "COMPLETE");
    assert.equal(factories, 2, "PARTIAL cache entry was not reused");
    await buildLspPrecisionOverlay({repoRoot: root, graph, graphPath, maxSymbols: 4, clientFactory});
    assert.equal(factories, 2, "matching COMPLETE cache entry was reused");
    await buildLspPrecisionOverlay({repoRoot: root, graph, graphPath, maxSymbols: 3, clientFactory});
    assert.equal(factories, 3, "a different request contract invalidated COMPLETE cache reuse");
    assert.equal(precisionOverlayMatches({...complete, providerContract: "old-provider-contract"}, graph), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("ignored configured inputs block no-reference proof and invalidate COMPLETE cache reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-ignored-input-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, ".gitignore"), "src/ignored-caller.ts\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({include: ["src/**/*.ts"]}));
  const targetFile = "src/target.ts";
  const ignoredFile = "src/ignored-caller.ts";
  writeFileSync(join(root, targetFile), "function target() {}\n");
  writeFileSync(join(root, ignoredFile), "function ignoredCaller() { target(); }\n");
  const target = symbolNode(targetFile, "target", 1, 1, {visibility: "private"});
  const snapshot = snapshotRepository(root, [join(root, targetFile)]);
  const graph = {
    graphRevision: snapshot.revision,
    graphBuildMode: "full",
    nodes: [fileNode(targetFile), target],
    links: [{source: targetFile, target: target.id, relation: "contains", provenance: "EXTRACTED"}],
    fileHashes: snapshot.fileHashes,
  };
  const cacheDirectory = join(root, ".weavatrix-test");
  mkdirSync(cacheDirectory, {recursive: true});
  const graphPath = join(cacheDirectory, "graph.json");
  let factories = 0;
  const clientFactory = async () => {
    factories++;
    return {async openDocument() {}, async references() { return []; }, async close() {}};
  };
  try {
    const first = await buildLspPrecisionOverlay({repoRoot: root, graph, graphPath, clientFactory});
    assert.equal(first.state, "COMPLETE", JSON.stringify(first));
    assert.deepEqual(first.noReferenceSymbols, [], "configured inputs omitted from the graph make absence unsafe");
    assert.equal(precisionSemanticInputsMatch(first, root, graph), true);
    writeFileSync(join(root, ignoredFile), "function ignoredCaller() { target(); target(); }\n");
    assert.equal(precisionSemanticInputsMatch(first, root, graph), false);
    const second = await buildLspPrecisionOverlay({repoRoot: root, graph, graphPath, clientFactory});
    assert.equal(second.state, "COMPLETE", JSON.stringify(second));
    assert.equal(factories, 2, "ignored configured input mutation invalidated COMPLETE cache reuse");
    assert.notEqual(second.semanticInputFingerprint, first.semanticInputFingerprint);
    assert.deepEqual(second.noReferenceSymbols, []);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("repo-bound graph loading refuses a COMPLETE sidecar after an ignored semantic input changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-safe-load-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, ".gitignore"), "src/ignored.ts\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({include: ["src/**/*.ts"]}));
  const callerFile = "src/caller.ts";
  const targetFile = "src/target.ts";
  const ignoredFile = "src/ignored.ts";
  const callerSource = "function caller() { return target(); }\n";
  writeFileSync(join(root, callerFile), callerSource);
  writeFileSync(join(root, targetFile), "function target() {}\n");
  writeFileSync(join(root, ignoredFile), "export const ignored = 1;\n");
  const caller = symbolNode(callerFile, "caller", 1, 1, {exported: true});
  const target = symbolNode(targetFile, "target", 1, 1, {visibility: "private"});
  const snapshot = snapshotRepository(root, [join(root, callerFile), join(root, targetFile)]);
  const graph = {
    graphRevision: snapshot.revision,
    graphBuildMode: "full",
    nodes: [fileNode(callerFile), fileNode(targetFile), caller, target],
    links: [
      {source: callerFile, target: caller.id, relation: "contains", provenance: "EXTRACTED"},
      {source: targetFile, target: target.id, relation: "contains", provenance: "EXTRACTED"},
      {source: caller.id, target: target.id, relation: "calls", line: 1, provenance: "INFERRED"},
    ],
    fileHashes: snapshot.fileHashes,
  };
  const graphDirectory = join(root, ".weavatrix-test");
  mkdirSync(graphDirectory, {recursive: true});
  const graphPath = join(graphDirectory, "graph.json");
  writeFileSync(graphPath, JSON.stringify(graph));
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      graphPath,
      clientFactory: async () => ({
        async openDocument() {},
        async references() {
          const character = callerSource.indexOf("target");
          return [{
            uri: pathToFileURL(join(root, callerFile)).href,
            range: {start: {line: 0, character}, end: {line: 0, character: character + 6}},
          }];
        },
        async close() {},
      }),
    });
    assert.equal(overlay.state, "COMPLETE", JSON.stringify(overlay));
    assert.ok(loadGraph(graphPath).links.some((link) => link.provenance === "EXACT_LSP"));

    writeFileSync(join(root, ignoredFile), "export const ignored = 2;\n");
    const safe = loadGraph(graphPath, {repoRoot: root});
    assert.equal(safe.links.some((link) => link.provenance === "EXACT_LSP"), false);
    assert.equal(safe.precision.state, "UNAVAILABLE");
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
