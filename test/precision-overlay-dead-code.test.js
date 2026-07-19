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

test("Java/Rust-only graphs report semantic precision as unavailable", async () => {
  let factoryCalled = false;
  const overlay = await buildLspPrecisionOverlay({
    repoRoot: process.cwd(),
    graph: {
      graphRevision: "revision-java",
      graphBuildMode: "full",
      nodes: [fileNode("src/Main.java")],
      links: [],
      fileHashes: {},
    },
    clientFactory: async () => { factoryCalled = true; throw new Error("must not start"); },
  });
  assert.equal(factoryCalled, false);
  assert.equal(overlay.state, "UNAVAILABLE");
  assert.match(overlay.reason, /JavaScript and TypeScript/);
});

test("post-build invalidation removes all exact and no-reference evidence", async () => {
  const root = makeRepo();
  const graph = withSnapshot(root, fixtureGraph());
  const cacheDirectory = join(root, ".weavatrix-test");
  mkdirSync(cacheDirectory, {recursive: true});
  const graphPath = join(cacheDirectory, "graph.json");
  try {
    await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      graphPath,
      clientFactory: async () => ({
        async openDocument() {},
        async references() {
          return [{
            uri: pathToFileURL(join(root, "src", "caller.ts")).href,
            range: {start: {line: 1, character: 9}, end: {line: 1, character: 15}},
          }];
        },
        async close() {},
      }),
    });
    const invalidated = invalidatePrecisionOverlay(graphPath, graph, "repository changed after semantic precision");
    assert.equal(invalidated.state, "PARTIAL");
    assert.equal(invalidated.coverage.verifiedEdges, 0);
    assert.deepEqual(invalidated.links, []);
    assert.deepEqual(invalidated.noReferenceSymbols, []);
    assert.equal(precisionOverlayMatches(invalidated, graph), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("dead-code confidence is high only with an explicit exact no-reference result", () => {
  const file = "src/orphan.ts";
  const orphan = symbolNode(file, "orphan", 2, 2, { visibility: "private" });
  const base = {
    nodes: [fileNode(file), orphan],
    links: [{ source: file, target: orphan.id, relation: "contains", provenance: "EXTRACTED" }],
  };
  const sources = new Map([[file, "function orphan() {}\n"]]);

  const staticOnly = computeDeadCodeReview(base, sources);
  const staticCandidate = staticOnly.candidates.find((candidate) => candidate.id === orphan.id);
  assert.equal(staticCandidate.confidence, "medium");
  assert.match(staticCandidate.caveats.join(" "), /static absence remains medium confidence/i);

  const exact = computeDeadCodeReview({ ...base, precisionNoReferenceSymbols: [orphan.id] }, sources);
  const exactCandidate = exact.candidates.find((candidate) => candidate.id === orphan.id);
  assert.equal(exactCandidate.confidence, "high");
  assert.ok(exactCandidate.evidence.some((evidence) => evidence.kind === "exact-lsp"));
});

test("an empty exact references result marks a bounded orphan and raises only that dead candidate to high", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-orphan-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({include: ["src/**/*.ts"]}));
  const file = "src/orphan.ts";
  const orphan = symbolNode(file, "orphan", 1, 1, { visibility: "private" });
  writeFileSync(join(root, "src", "orphan.ts"), "function orphan() {}\n");
  const graph = withSnapshot(root, {
    graphRevision: "revision-orphan",
    graphBuildMode: "full",
    nodes: [fileNode(file), orphan],
    links: [{ source: file, target: orphan.id, relation: "contains", provenance: "EXTRACTED" }],
  });
  let queried = 0;
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => ({
        async openDocument() {},
        async references(filePath, position, includeDeclaration) {
          queried++;
          assert.equal(filePath, file);
          assert.deepEqual(position, orphan.selection_start);
          assert.equal(includeDeclaration, false);
          return [];
        },
        async close() {},
      }),
    });
    assert.equal(queried, 1, JSON.stringify(overlay));
    assert.equal(overlay.state, "COMPLETE");
    assert.deepEqual(overlay.noReferenceSymbols, [orphan.id]);

    const merged = mergePrecisionOverlay(graph, overlay);
    const review = computeDeadCodeReview(merged, new Map([[file, "function orphan() {}\n"]]));
    const candidate = review.candidates.find((entry) => entry.id === orphan.id);
    assert.equal(candidate.confidence, "high");
    assert.ok(candidate.evidence.some((evidence) => evidence.kind === "exact-lsp"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

