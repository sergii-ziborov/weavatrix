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

test("LSP overlay adds an occurrence-specific reference without upgrading a line-only call", async () => {
  const root = makeRepo();
  const graph = withSnapshot(root, fixtureGraph());
  const calls = [];
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => ({
        provider: "fake-exact-lsp",
        version: "1.0.0",
        async openDocument() {},
        async references(file, position, includeDeclaration) {
          calls.push({ file, position, includeDeclaration });
          return [{
            uri: pathToFileURL(join(root, "src", "caller.ts")).href,
            range: { start: { line: 1, character: 9 }, end: { line: 1, character: 15 } },
          }];
        },
        async close() {},
      }),
    });

    assert.equal(overlay.state, "COMPLETE", JSON.stringify(overlay));
    assert.equal(overlay.coverage.verifiedEdges, 1);
    assert.deepEqual(calls, [{
      file: "src/target.ts",
      position: { line: 0, character: 16 },
      includeDeclaration: false,
    }]);

    const merged = mergePrecisionOverlay(graph, overlay);
    const real = merged.links.find((link) => String(link.source).includes("realCaller") && link.relation === "calls");
    const decoy = merged.links.find((link) => String(link.source).includes("decoyCaller") && link.relation === "calls");
    const exactReference = merged.links.find((link) => String(link.source).includes("realCaller")
      && link.relation === "references" && link.character === 9);
    assert.equal(real.provenance, "INFERRED");
    assert.equal(decoy.provenance, "INFERRED");
    assert.equal(exactReference.provenance, "EXACT_LSP");
    assert.equal(exactReference.precisionProvider, "typescript-language-server");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("revision or graph-mode mismatch rejects the overlay and leaves the raw graph pristine", () => {
  const graph = fixtureGraph("no-tests");
  const rawBefore = JSON.stringify(graph);
  const exact = {
    precisionOverlayV: PRECISION_OVERLAY_V,
    baseGraphRevision: graph.graphRevision,
    graphBuildMode: graph.graphBuildMode,
    graphBuildScope: "",
    precisionMode: "lsp",
    providerContract: typeScriptLspContract(),
    graphContract: {extractorSchemaV: 0},
    state: "COMPLETE",
    coverage: { candidates: 1, selected: 1, queried: 1, references: 1, verifiedEdges: 1, truncated: false },
    links: [{
      source: "src/caller.ts#realCaller@2",
      target: "src/target.ts#target@1",
      relation: "calls",
      line: 3,
      provider: "fake-exact-lsp",
    }],
    noReferenceSymbols: [],
  };

  assert.equal(precisionOverlayMatches(exact, graph), true);
  assert.equal(precisionOverlayMatches({ ...exact, baseGraphRevision: "stale" }, graph), false);
  assert.equal(precisionOverlayMatches({ ...exact, graphBuildMode: "full" }, graph), false);
  assert.equal(precisionOverlayMatches({ ...exact, precisionMode: "off" }, graph), false);
  assert.equal(precisionOverlayMatches({ ...exact, graphContract: {extractorSchemaV: 1} }, graph), false);

  for (const invalid of [
    { ...exact, baseGraphRevision: "stale" },
    { ...exact, graphBuildMode: "full" },
    { ...exact, precisionMode: "off" },
    { ...exact, graphContract: {extractorSchemaV: 1} },
  ]) {
    const merged = mergePrecisionOverlay(graph, invalid);
    assert.equal(merged.precision.state, "UNAVAILABLE");
    assert.equal(merged.links.some((link) => link.provenance === "EXACT_LSP"), false);
  }
  assert.equal(JSON.stringify(graph), rawBefore, "precision merging cannot alter the static graph used by graph_diff");
});

test("no-tests precision cannot reintroduce a reference from a removed test node", async () => {
  const root = makeRepo();
  const graph = withSnapshot(root, fixtureGraph("no-tests"));
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => ({
        async openDocument() {},
        async references() {
          return [{
            uri: pathToFileURL(join(root, "test", "target.test.ts")).href,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
          }];
        },
        async close() {},
      }),
    });
    assert.deepEqual(overlay.links, []);
    const merged = mergePrecisionOverlay(graph, overlay);
    assert.equal(merged.nodes.some((node) => String(node.id).startsWith("test/")), false);
    assert.equal(merged.links.some((link) => String(link.source).startsWith("test/")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reference on a different line becomes an exact references edge, never an unrelated exact call", async () => {
  const root = makeRepo();
  const base = fixtureGraph();
  const graph = withSnapshot(root, {
    ...base,
    links: [
      ...base.links.map((link) => link.relation === "calls" ? {...link, line: 99} : link),
      {
        source: "src/caller.ts#realCaller@2",
        target: "src/target.ts#target@1",
        relation: "references",
        provenance: "INFERRED",
      },
    ],
  });
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
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
    assert.equal(overlay.state, "COMPLETE", JSON.stringify(overlay));
    assert.ok(overlay.links.some((link) => link.relation === "references" && link.line === 2));
    const merged = mergePrecisionOverlay(graph, overlay);
    assert.ok(merged.links.filter((link) => link.relation === "calls").every((link) => link.provenance === "INFERRED"));
    assert.equal(merged.links.find((link) => link.relation === "references" && !Number.isInteger(link.line)).provenance, "INFERRED");
    assert.ok(merged.links.some((link) => link.relation === "references" && link.provenance === "EXACT_LSP"));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("an unclassifiable unmatched reference remains separate evidence and never becomes runtime", async () => {
  const root = makeRepo();
  const base = fixtureGraph();
  const graph = withSnapshot(root, {
    ...base,
    links: base.links.map((link) => link.relation === "calls" ? {...link, line: 99} : link),
  });
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => ({
        async openDocument() {},
        async references() {
          return [{
            uri: pathToFileURL(join(root, "src", "caller.ts")).href,
            range: {start: {line: 2, character: 0}, end: {line: 2, character: 1}},
          }];
        },
        async close() {},
      }),
    });
    assert.equal(overlay.state, "PARTIAL");
    assert.deepEqual(overlay.links, []);
    assert.equal(overlay.coverage.unclassifiedReferences, 1);
    assert.deepEqual(overlay.referenceEvidence.map((evidence) => evidence.classification), ["unknown"]);
    const merged = mergePrecisionOverlay(graph, overlay);
    assert.equal(merged.links.some((link) => link.provenance === "EXACT_LSP"), false);
    assert.equal(merged.precisionReferenceEvidence.length, 1);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("a same-line import reference stays on the file node and preserves type-only metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-boundary-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({include: ["src/**/*.ts"]}));
  const mixedFile = "src/mixed.ts";
  const targetFile = "src/target.ts";
  const mixedSource = 'import type { target } from "./target"; export function decoy() { return 1; }\n';
  writeFileSync(join(root, mixedFile), mixedSource);
  writeFileSync(join(root, targetFile), "export function target() {}\n");
  const decoy = symbolNode(mixedFile, "decoy", 1, 1, {
    exported: true,
    source_range: {
      start: {line: 0, character: mixedSource.indexOf("function")},
      end: {line: 0, character: mixedSource.trimEnd().length},
    },
  });
  const target = symbolNode(targetFile, "target", 1, 1);
  const graph = withSnapshot(root, {
    graphRevision: "revision-boundary",
    graphBuildMode: "full",
    nodes: [fileNode(mixedFile), fileNode(targetFile), decoy, target],
    links: [
      {source: mixedFile, target: decoy.id, relation: "contains", provenance: "EXTRACTED"},
      {source: targetFile, target: target.id, relation: "contains", provenance: "EXTRACTED"},
      {source: mixedFile, target: targetFile, relation: "imports", line: 1, typeOnly: true, provenance: "RESOLVED"},
      {source: decoy.id, target: target.id, relation: "calls", line: 1, provenance: "INFERRED"},
    ],
  });
  try {
    const overlay = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      clientFactory: async () => ({
        async openDocument() {},
        async references() {
          return [{
            uri: pathToFileURL(join(root, mixedFile)).href,
            range: {start: {line: 0, character: 14}, end: {line: 0, character: 20}},
          }];
        },
        async close() {},
      }),
    });
    assert.deepEqual(overlay.links.map((link) => ({source: link.source, relation: link.relation, typeOnly: link.typeOnly})), [
      {source: mixedFile, relation: "references", typeOnly: true},
    ]);
    const merged = mergePrecisionOverlay(graph, overlay);
    assert.equal(merged.links.find((link) => link.source === decoy.id && link.relation === "calls").provenance, "INFERRED");
    const exact = merged.links.find((link) => link.source === mixedFile
      && link.target === target.id && link.relation === "references");
    assert.equal(exact.provenance, "EXACT_LSP");
    assert.equal(exact.typeOnly, true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

