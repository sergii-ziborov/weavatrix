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

test("configured TypeScript plugins are suppressed without disabling semantic precision", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-plugin-preflight-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {plugins: [{name: "evil-plugin"}]},
    include: ["src/**/*.ts"],
  }));
  const file = "src/orphan.ts";
  writeFileSync(join(root, file), "function orphan() {}\n");
  const orphan = symbolNode(file, "orphan", 1, 1, {visibility: "private"});
  const graph = withSnapshot(root, {
    graphRevision: "revision-plugin-preflight",
    graphBuildMode: "full",
    nodes: [fileNode(file), orphan],
    links: [{source: file, target: orphan.id, relation: "contains", provenance: "EXTRACTED"}],
  });
  let factoryCalled = false;
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => {
        factoryCalled = true;
        return {
          provider: "fixture-lsp",
          async openDocument() {},
          async references() { return []; },
          async close() {},
        };
      },
    });
    assert.equal(factoryCalled, true);
    assert.equal(overlay.state, "COMPLETE");
    assert.equal(overlay.pluginPolicy.configuredPluginsSuppressed, 1);
    assert.equal(overlay.pluginPolicy.repoLocalPluginLoads, false);
    assert.equal(overlay.engines[0].configuredPluginsSuppressed, 1);
    assert.deepEqual(overlay.links, []);
    assert.deepEqual(overlay.noReferenceSymbols, [orphan.id]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("the target budget reserves a slot for an internal orphan", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-reservation-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({include: ["src/**/*.ts"]}));
  const caller = symbolNode("src/caller.ts", "caller", 1, 1, {exported: true});
  writeFileSync(join(root, "src", "caller.ts"), "export function caller() {}\n");
  const targets = [];
  for (let index = 0; index < 5; index++) {
    const file = `src/positive-${index}.ts`;
    writeFileSync(join(root, file), `function positive${index}() {}\n`);
    targets.push(symbolNode(file, `positive${index}`, 1, 1));
  }
  const orphanFile = "src/orphan.ts";
  const orphan = symbolNode(orphanFile, "orphan", 1, 1, {visibility: "private"});
  writeFileSync(join(root, orphanFile), "function orphan() {}\n");
  const nodes = [fileNode("src/caller.ts"), caller, fileNode(orphanFile), orphan];
  const links = [
    {source: "src/caller.ts", target: caller.id, relation: "contains", provenance: "EXTRACTED"},
    {source: orphanFile, target: orphan.id, relation: "contains", provenance: "EXTRACTED"},
  ];
  for (const target of targets) {
    nodes.push(fileNode(target.source_file), target);
    links.push({source: target.source_file, target: target.id, relation: "contains", provenance: "EXTRACTED"});
    links.push({source: caller.id, target: target.id, relation: "calls", line: 1, provenance: "INFERRED"});
  }
  const graph = withSnapshot(root, {
    graphRevision: "revision-reservation",
    graphBuildMode: "full",
    nodes,
    links,
  });
  const queriedFiles = [];
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      maxSymbols: 4,
      clientFactory: async () => ({
        async openDocument() {},
        async references(file) {
          queriedFiles.push(file);
          return [{
            uri: pathToFileURL(join(root, file)).href,
            range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}},
          }];
        },
        async close() {},
      }),
    });
    assert.equal(overlay.coverage.candidates, 6);
    assert.equal(overlay.coverage.selected, 4);
    assert.equal(overlay.state, "PARTIAL");
    assert.ok(queriedFiles.includes(orphanFile), JSON.stringify(queriedFiles));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
