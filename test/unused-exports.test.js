// computeUnusedExports — export-scoped dead check (knip's "unused exports"), pure inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeUnusedExports } from "../src/analysis/dead-check.js";
import { collectSourceTexts } from "../src/analysis/internal-audit.js";

const fileNode = (f) => ({ id: f, label: f.split("/").pop(), source_file: f });
const sym = (f, name, line, exported) => ({ id: `${f}#${name}@${line}`, label: `${name}()`, source_file: f, ...(exported ? { exported: true } : {}) });
const contains = (f, id) => ({ source: f, target: id, relation: "contains", confidence: "EXTRACTED" });

test("unused-exports: exported+unreferenced flagged; imported / text-referenced / internal not", () => {
  const a = "src/a.js", b = "src/b.js";
  const orphanExport = sym(a, "orphanExport", 1, true);      // exported, referenced nowhere
  const usedByEdge = sym(a, "usedByEdge", 5, true);          // exported, has a calls edge
  const usedByText = sym(a, "usedByText", 9, true);          // exported, name appears in b's text only
  const internalHelper = sym(a, "internalHelper", 13, false); // NOT exported → out of scope
  const caller = sym(b, "caller", 1, false); // not exported — otherwise it'd (correctly) be flagged too
  const graph = {
    nodes: [fileNode(a), fileNode(b), orphanExport, usedByEdge, usedByText, internalHelper, caller],
    links: [
      contains(a, orphanExport.id), contains(a, usedByEdge.id), contains(a, usedByText.id), contains(a, internalHelper.id), contains(b, caller.id),
      { source: caller.id, target: usedByEdge.id, relation: "calls", confidence: "INFERRED" },
      { source: b, target: a, relation: "imports", confidence: "EXTRACTED" },
      { source: b, target: caller.id, relation: "contains", confidence: "EXTRACTED" },
    ],
  };
  const sources = new Map([
    [a, "export function orphanExport(){}\nexport function usedByEdge(){}\nexport function usedByText(){}\nfunction internalHelper(){}"],
    [b, "import { usedByEdge, usedByText } from './a.js';\nexport function caller(){ usedByEdge(); return usedByText; }"],
  ]);
  const out = computeUnusedExports(graph, sources);
  assert.deepEqual(out.map((s) => s.label), ["orphanExport()"]);
  assert.equal(out[0].test, false);
});

test("unused-exports: entry files, dynamic-import targets and inbound-edged symbols are exempt", () => {
  const entry = "src/index.js", dyn = "src/lazy.js", plain = "src/util.js";
  const fromEntry = sym(entry, "boot", 1, true);
  const fromDyn = sym(dyn, "lazyThing", 1, true);
  const fromPlain = sym(plain, "reallyUnused", 1, true);
  const graph = {
    nodes: [fileNode(entry), fileNode(dyn), fileNode(plain), fromEntry, fromDyn, fromPlain],
    links: [contains(entry, fromEntry.id), contains(dyn, fromDyn.id), contains(plain, fromPlain.id)],
  };
  const sources = new Map([[entry, "export function boot(){}"], [dyn, "export function lazyThing(){}"], [plain, "export function reallyUnused(){}"]]);
  const out = computeUnusedExports(graph, sources, { dynamicTargets: new Set([dyn]) });
  assert.deepEqual(out.map((s) => s.label), ["reallyUnused()"]);
});

test("unused-exports: repo source fallback sees imports from files missing in graph.json", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-unused-"));
  try {
    mkdirSync(join(repo, "src", "widget", "config"), { recursive: true });
    mkdirSync(join(repo, "src", "widget", "definition", "controls"), { recursive: true });
    writeFileSync(join(repo, "src", "widget", "config", "defaults.js"), "export const DEFAULT_TABLE_ROWS_PER_PAGE = 50;\n");
    writeFileSync(
      join(repo, "src", "widget", "definition", "controls", "constants.js"),
      "import { DEFAULT_TABLE_ROWS_PER_PAGE } from '../../config/defaults.js';\n" +
        "export const WidgetSchemaConfig = { defaultTableRowsPerPage: DEFAULT_TABLE_ROWS_PER_PAGE };\n"
    );

    const exported = { id: "src/widget/config/defaults.js#DEFAULT_TABLE_ROWS_PER_PAGE@1", label: "DEFAULT_TABLE_ROWS_PER_PAGE", source_file: "src/widget/config/defaults.js", exported: true };
    const graph = {
      nodes: [fileNode("src/widget/config/defaults.js"), exported],
      links: [contains("src/widget/config/defaults.js", exported.id)],
    };
    const sources = collectSourceTexts(repo, graph);
    assert.equal(sources.has("src/widget/definition/controls/constants.js"), true);
    assert.deepEqual(computeUnusedExports(graph, sources), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
