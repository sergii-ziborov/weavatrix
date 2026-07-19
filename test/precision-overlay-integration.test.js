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

