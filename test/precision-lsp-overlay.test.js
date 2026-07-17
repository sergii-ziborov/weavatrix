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

const fileNode = (file) => ({ id: file, label: file, source_file: file, file_type: "code" });
const symbolNode = (file, name, line, end = line, extra = {}) => ({
  id: `${file}#${name}@${line}`,
  label: `${name}()`,
  source_file: file,
  source_location: `L${line}`,
  source_end: `L${end}`,
  source_range: {
    start: { line: line - 1, character: 0 },
    end: { line: end - 1, character: 1_000 },
  },
  selection_start: { line: line - 1, character: 16 },
  symbol_kind: "function",
  ...extra,
});

const withSnapshot = (root, graph) => ({...graph, fileHashes: snapshotRepository(root).fileHashes});

function fixtureGraph(mode = "full") {
  const caller = symbolNode("src/caller.ts", "realCaller", 2, 4, { exported: true });
  const decoy = symbolNode("src/decoy.ts", "decoyCaller", 2, 4, { exported: true });
  const target = symbolNode("src/target.ts", "target", 1, 1);
  return {
    graphRevision: "revision-a",
    graphBuildMode: mode,
    nodes: [
      fileNode("src/caller.ts"),
      fileNode("src/decoy.ts"),
      fileNode("src/target.ts"),
      caller,
      decoy,
      target,
    ],
    links: [
      { source: "src/caller.ts", target: caller.id, relation: "contains", provenance: "EXTRACTED" },
      { source: "src/decoy.ts", target: decoy.id, relation: "contains", provenance: "EXTRACTED" },
      { source: "src/target.ts", target: target.id, relation: "contains", provenance: "EXTRACTED" },
      { source: caller.id, target: target.id, relation: "calls", line: 3, provenance: "INFERRED" },
      { source: decoy.id, target: target.id, relation: "calls", line: 3, provenance: "INFERRED" },
    ],
  };
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-overlay-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }));
  writeFileSync(join(root, "src", "caller.ts"), "export function realCaller() {\n  return target();\n}\n");
  writeFileSync(join(root, "src", "decoy.ts"), "export function decoyCaller() {\n  return target();\n}\n");
  writeFileSync(join(root, "src", "target.ts"), "export function target() {}\n");
  writeFileSync(join(root, "test", "target.test.ts"), "target();\n");
  return root;
}

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

test("configured TypeScript plugins fail closed before the client factory is called", async () => {
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
      clientFactory: async () => { factoryCalled = true; throw new Error("must not spawn"); },
    });
    assert.equal(factoryCalled, false);
    assert.equal(overlay.state, "UNAVAILABLE");
    assert.match(overlay.reason, /plugins are not allowed/i);
    assert.deepEqual(overlay.links, []);
    assert.deepEqual(overlay.noReferenceSymbols, []);
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

test("bundled TypeScript LSP keeps type-query references type-only while preserving a value call", {timeout: 60_000}, async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-real-ts-usage-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, "package.json"), JSON.stringify({name: "reference-usage-fixture", type: "module"}));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {strict: true, target: "ES2022", module: "ESNext", noEmit: true},
    include: ["src/**/*.ts"],
  }));
  writeFileSync(join(root, "src", "usage.ts"), [
    "function helper(): number { return 1; }",
    "type Helper = typeof helper;",
    "export function run(): Helper { return helper(); }",
    "",
  ].join("\n"));
  try {
    const built = await buildInternalGraph(root);
    const helper = built.nodes.find((node) => node.source_file === "src/usage.ts" && node.label === "helper()");
    const run = built.nodes.find((node) => node.source_file === "src/usage.ts" && node.label === "run()");
    assert.ok(helper && run);
    const graph = {...built, graphBuildMode: "full"};
    const overlay = await buildLspPrecisionOverlay({repoRoot: root, graph, timeoutMs: 20_000});
    assert.equal(overlay.state, "COMPLETE", JSON.stringify(overlay));
    const typeQuery = overlay.links.find((link) => link.target === helper.id && link.line === 2);
    const valueReference = overlay.links.find((link) => link.source === run.id
      && link.target === helper.id && link.line === 3 && link.relation === "references");
    assert.equal(typeQuery?.relation, "references", JSON.stringify(overlay.links));
    assert.equal(typeQuery?.typeOnly, true, JSON.stringify(typeQuery));
    assert.ok(valueReference, JSON.stringify(overlay.links));
    assert.notEqual(valueReference.typeOnly, true);

    const merged = mergePrecisionOverlay(graph, overlay);
    assert.equal(merged.links.find((link) => link.source === typeQuery.source
      && link.target === helper.id && link.line === 2 && link.relation === "references")?.typeOnly, true);
    assert.equal(merged.links.find((link) => link.source === run.id
      && link.target === helper.id && link.line === 3 && link.relation === "calls")?.provenance, "INFERRED");
    assert.equal(merged.links.find((link) => link.source === run.id
      && link.target === helper.id && link.line === 3 && link.relation === "references")?.provenance, "EXACT_LSP");
  } finally {
    rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});

test("bundled TypeScript LSP proves the imported call without blessing a same-name decoy", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-real-ts-lsp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "strict-lsp-fixture", type: "module" }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }));
  writeFileSync(join(root, "src", "lib.ts"), "export function select(value: string): string { return value; }\n");
  writeFileSync(join(root, "src", "decoy.ts"), "export function select(value: number): number { return value; }\n");
  writeFileSync(join(root, "src", "app.ts"), [
    'import { select } from "./lib";',
    'const marker = "\u{1F600}\u6F22"; export function run(): string { return select("chosen"); }',
    "",
  ].join("\n"));

  try {
    const built = await buildInternalGraph(root);
    const run = built.nodes.find((node) => node.source_file === "src/app.ts" && node.label === "run()");
    const selected = built.nodes.find((node) => node.source_file === "src/lib.ts" && node.label === "select()");
    const decoy = built.nodes.find((node) => node.source_file === "src/decoy.ts" && node.label === "select()");
    assert.ok(run && selected && decoy, "strict fixture symbols are indexed");
    assert.ok(built.links.some((link) => String(link.source) === run.id && String(link.target) === selected.id && link.relation === "calls"));

    const graph = {
      ...built,
      graphBuildMode: "full",
      links: [
        ...built.links,
        { source: run.id, target: decoy.id, relation: "calls", provenance: "INFERRED", confidence: "INFERRED" },
      ],
    };
    const overlay = await buildLspPrecisionOverlay({ repoRoot: root, graph, timeoutMs: 20_000 });
    assert.equal(overlay.state, "COMPLETE", JSON.stringify(overlay));
    assert.equal(overlay.engines[0].provider, "typescript-language-server");
    assert.match(String(overlay.engines[0].version), /^\d+\.\d+\.\d+/);
    assert.ok(overlay.coverage.verifiedEdges > 0, JSON.stringify(overlay));

    const merged = mergePrecisionOverlay(graph, overlay);
    const selectedCall = merged.links.find((link) => String(link.source) === run.id
      && String(link.target) === selected.id && link.relation === "calls");
    const decoyCall = merged.links.find((link) => String(link.source) === run.id
      && String(link.target) === decoy.id && link.relation === "calls");
    const selectedReference = merged.links.find((link) => String(link.source) === run.id
      && String(link.target) === selected.id && link.relation === "references"
      && link.provenance === "EXACT_LSP");
    const decoyReference = merged.links.find((link) => String(link.source) === run.id
      && String(link.target) === decoy.id && link.relation === "references"
      && link.provenance === "EXACT_LSP");
    assert.equal(selectedCall.provenance, "INFERRED");
    assert.equal(decoyCall.provenance, "INFERRED");
    assert.ok(selectedReference, JSON.stringify(merged.links));
    assert.equal(decoyReference, undefined);
  } finally {
    // Windows can release tsserver's watched temp directory just after the LSP parent exits.
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("same-line type evidence never upgrades a shadowed static call", {timeout: 60_000}, async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-real-ts-shadowed-line-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, "package.json"), JSON.stringify({name: "shadowed-line-fixture", type: "module"}));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true},
    include: ["src/**/*.ts"],
  }));
  writeFileSync(join(root, "src", "lib.ts"), "export function helper(): number { return 1; }\n");
  const runLine = "export function run(h: () => number): number { type T = typeof actual; h(); return 1; }";
  writeFileSync(join(root, "src", "app.ts"), [
    'import { helper as h, helper as actual } from "./lib";',
    runLine,
    "",
  ].join("\n"));
  try {
    const built = await buildInternalGraph(root);
    const run = built.nodes.find((node) => node.source_file === "src/app.ts" && node.label === "run()");
    const typeAlias = built.nodes.find((node) => node.source_file === "src/app.ts" && node.label === "T"
      && node.symbol_space === "type");
    const helper = built.nodes.find((node) => node.source_file === "src/lib.ts" && node.label === "helper()");
    assert.ok(run && typeAlias && helper, "shadowing fixture symbols are indexed in their TypeScript spaces");
    const staticCall = {source: run.id, target: helper.id, relation: "calls", line: 2, provenance: "INFERRED"};
    const graph = {
      ...built,
      graphBuildMode: "full",
      links: [...built.links.filter((link) => !(String(link.source) === run.id
        && String(link.target) === helper.id && link.relation === "calls")), staticCall],
    };
    const overlay = await buildLspPrecisionOverlay({repoRoot: root, graph, timeoutMs: 20_000});
    assert.equal(overlay.state, "COMPLETE", JSON.stringify(overlay));
    const typeColumn = runLine.indexOf("actual");
    const callColumn = runLine.indexOf("h();");
    const exactType = overlay.links.find((link) => link.source === typeAlias.id && link.target === helper.id
      && link.relation === "references" && link.line === 2 && link.character === typeColumn);
    assert.equal(exactType?.typeOnly, true, JSON.stringify(overlay.links));
    assert.equal(overlay.links.some((link) => link.source === run.id && link.target === helper.id
      && link.character === callColumn), false, "the shadowed parameter call is not a reference to the import");

    const merged = mergePrecisionOverlay(graph, overlay);
    assert.equal(merged.links.find((link) => link.source === run.id && link.target === helper.id
      && link.relation === "calls")?.provenance, "INFERRED");
    assert.equal(merged.links.find((link) => link.source === typeAlias.id && link.target === helper.id
      && link.relation === "references" && link.character === typeColumn)?.provenance, "EXACT_LSP");
  } finally {
    rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});
