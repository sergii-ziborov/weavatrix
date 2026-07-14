import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTestPath,
  filterGraphForMode,
  filterGraphByScope,
  aggregateGraph,
  graphOutDirForRepo,
  graphOutDirForModule
} from "../src/graph/layout.js";
import { repoBaseName } from "../src/scan/discover.js";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("isTestPath: recognises common test file conventions", () => {
  assert.equal(isTestPath("src/foo.test.js"), true);
  assert.equal(isTestPath("src/__tests__/foo.js"), true);
  assert.equal(isTestPath("tests/foo.js"), true);
  assert.equal(isTestPath("pkg/foo_test.go"), true);
  assert.equal(isTestPath("pkg/test_thing.py"), true);
});

test("isTestPath: leaves production paths alone", () => {
  assert.equal(isTestPath("src/foo.js"), false);
  assert.equal(isTestPath("src/contestant.js"), false); // 'test' inside a word must not match
});

const graph = () => ({
  nodes: [
    { id: "a", source_file: "src/a.js" },
    { id: "b", source_file: "src/b.js" },
    { id: "t", source_file: "src/a.test.js" }
  ],
  links: [
    { source: "t", target: "a" }, // a test depending on production code
    { source: "a", target: "b" }
  ]
});

test("filterGraphForMode: 'full' (or unknown) returns the graph unchanged", () => {
  const g = graph();
  assert.equal(filterGraphForMode(g, "full"), g);
});

test("filterGraphForMode: 'no-tests' drops test nodes and links touching them", () => {
  const g = filterGraphForMode(graph(), "no-tests");
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["a", "b"]);
  assert.deepEqual(g.links, [{ source: "a", target: "b" }]);
});

test("filterGraphForMode: 'tests-only' keeps tests plus their direct dependencies", () => {
  const g = filterGraphForMode(graph(), "tests-only");
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["a", "t"]);
  assert.deepEqual(g.links, [{ source: "t", target: "a" }]);
});

test("filterGraphForMode: resolves object-shaped link endpoints ({id})", () => {
  const g = filterGraphForMode(
    {
      nodes: [
        { id: "a", source_file: "src/a.js" },
        { id: "t", source_file: "src/a.test.js" }
      ],
      links: [{ source: { id: "t" }, target: { id: "a" } }]
    },
    "no-tests"
  );
  assert.deepEqual(g.nodes.map((n) => n.id), ["a"]);
  assert.deepEqual(g.links, []);
});

test("filterGraphByScope: keeps only nodes under the prefix and prunes dangling links", () => {
  const g = filterGraphByScope(
    {
      nodes: [
        { id: "x", source_file: "src/api/x.js" },
        { id: "y", source_file: "src/web/y.js" }
      ],
      links: [{ source: "x", target: "y" }]
    },
    "src/api"
  );
  assert.deepEqual(g.nodes.map((n) => n.id), ["x"]);
  assert.deepEqual(g.links, []);
});

test("filterGraphByScope: normalises backslash paths before matching", () => {
  const g = filterGraphByScope(
    { nodes: [{ id: "x", source_file: "src\\api\\x.js" }], links: [] },
    "src/api"
  );
  assert.deepEqual(g.nodes.map((n) => n.id), ["x"]);
});

test("aggregateGraph: rolls files up into folder modules with file/module edges", () => {
  const result = aggregateGraph({
    nodes: [
      { id: "f1", file_type: "code", source_file: "src/api/a.js" },
      { id: "f1#fn", file_type: "code", source_file: "src/api/a.js" },
      { id: "f2", file_type: "code", source_file: "src/web/b.js" },
      { id: "f2#fn", file_type: "code", source_file: "src/web/b.js" }
    ],
    links: [
      { source: "f1", target: "f1#fn", relation: "contains" },
      { source: "f2", target: "f2#fn", relation: "contains" },
      { source: "f1#fn", target: "f2#fn", relation: "calls" }
    ]
  });

  assert.deepEqual(
    result.modules.map((m) => m.name).sort(),
    ["src/api", "src/web"]
  );
  for (const mod of result.modules) {
    assert.equal(mod.fileCount, 1);
    assert.equal(mod.symbolCount, 1);
  }
  assert.deepEqual(result.moduleEdges, [{ from: "src/api", to: "src/web", count: 1 }]);
  assert.deepEqual(result.fileEdges, [{ from: "src/api/a.js", to: "src/web/b.js", count: 1, relation: "calls" }]);
  assert.equal(result.symbols.length, 2);
  assert.equal(result.symbolEdges.length, 1);
  assert.equal(result.folderLoc, null); // no repoRoot => no filesystem reads
  assert.deepEqual(result.totals, {
    files: 2,
    nodes: 4,
    fileEdges: 1,
    moduleEdges: 1,
    symbols: 2,
    symbolEdges: 1
  });
});

test("aggregateGraph: excludes non-code nodes from counts and 'contains' edges from the rollup", () => {
  const result = aggregateGraph({
    nodes: [
      { id: "f1", file_type: "code", source_file: "src/a.js" },
      { id: "f1#fn", file_type: "code", source_file: "src/a.js" },
      { id: "doc", file_type: "doc", source_file: "README.md" }
    ],
    links: [{ source: "f1", target: "f1#fn", relation: "contains" }]
  });
  assert.equal(result.totals.files, 1); // the doc node is not counted as a file
  assert.equal(result.totals.nodes, 2); // both code nodes count; the doc node does not
  // a 'contains' edge (file -> its own symbol) is structural, not a dependency, so no edges roll up
  assert.deepEqual(result.fileEdges, []);
  assert.deepEqual(result.moduleEdges, []);
});

test("aggregateGraph: emits real local symbol references from source text", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-graph-builder-"));
  try {
    const rel = join("src", "query", "sql", "parser.js");
    mkdirSync(join(root, "src", "query", "sql"), { recursive: true });
    writeFileSync(
      join(root, rel),
      [
        "const distinctPrefixRegex = /^DISTINCT\\b/i",
        "const unusedHelper = () => 1",
        "export const parseQueryText = (rawSelectText) => {",
        "  const distinct = distinctPrefixRegex.test(rawSelectText)",
        "  return distinct ? rawSelectText.replace(distinctPrefixRegex, '').trim() : rawSelectText",
        "}"
      ].join("\n"),
      "utf8"
    );

    const result = aggregateGraph(
      {
        nodes: [
          { id: "file", file_type: "code", source_file: rel },
          { id: "distinct-prefix", file_type: "code", source_file: rel, label: "distinctPrefixRegex", source_location: "L1" },
          { id: "unused-helper", file_type: "code", source_file: rel, label: "unusedHelper", source_location: "L2" },
          { id: "parse-query", file_type: "code", source_file: rel, label: "parseQueryText", source_location: "L3" }
        ],
        links: [
          { source: "file", target: "distinct-prefix", relation: "contains" },
          { source: "file", target: "unused-helper", relation: "contains" },
          { source: "file", target: "parse-query", relation: "contains" }
        ]
      },
      root
    );

    const refs = new Map(result.symbolRefs.map((ref) => [ref.id, ref.localRefs]));
    assert.equal(refs.get("distinct-prefix"), 2);
    assert.equal(refs.has("unused-helper"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregateGraph: emits external refs for imported value collections", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-graph-builder-"));
  try {
    const timeSeries = "src/widget/shape/time-series.js";
    const service = "src/widget/shape/service.js";
    const schema = "src/widget/shape/schema.js";
    mkdirSync(join(root, "src", "widget", "shape"), { recursive: true });
    writeFileSync(
      join(root, "src", "widget", "shape", "time-series.js"),
      [
        "export const TimeSeriesWidgetTypes = new Set([",
        "  'time_series',",
        "  'stacked_area',",
        "])",
        "export const shapeTimeSeriesRows = (rows) => rows"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(root, "src", "widget", "shape", "service.js"),
      [
        "import { TimeSeriesWidgetTypes, shapeTimeSeriesRows } from './time-series.js'",
        "export const shapeWidgetRows = (rows, widget) => {",
        "  if (TimeSeriesWidgetTypes.has(widget.type)) return shapeTimeSeriesRows(rows)",
        "  return rows",
        "}"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(root, "src", "widget", "shape", "schema.js"),
      [
        "import { TimeSeriesWidgetTypes } from './time-series.js'",
        "export const shapeWidgetResultSchema = (schema, widget) => {",
        "  return TimeSeriesWidgetTypes.has(widget.type) ? schema.slice() : schema",
        "}"
      ].join("\n"),
      "utf8"
    );

    const result = aggregateGraph(
      {
        nodes: [
          { id: "time-file", file_type: "code", source_file: timeSeries },
          { id: "time-types", file_type: "code", source_file: timeSeries, label: "TimeSeriesWidgetTypes", source_location: "L1" },
          { id: "shape-rows", file_type: "code", source_file: timeSeries, label: "shapeTimeSeriesRows", source_location: "L5" },
          { id: "service-file", file_type: "code", source_file: service },
          { id: "shape-widget-rows", file_type: "code", source_file: service, label: "shapeWidgetRows", source_location: "L2" },
          { id: "schema-file", file_type: "code", source_file: schema },
          { id: "shape-widget-schema", file_type: "code", source_file: schema, label: "shapeWidgetResultSchema", source_location: "L2" }
        ],
        links: [
          { source: "time-file", target: "time-types", relation: "contains" },
          { source: "time-file", target: "shape-rows", relation: "contains" },
          { source: "service-file", target: "shape-widget-rows", relation: "contains" },
          { source: "schema-file", target: "shape-widget-schema", relation: "contains" }
        ]
      },
      root
    );

    const refs = new Map(result.symbolRefs.map((ref) => [ref.id, ref]));
    assert.equal(refs.get("time-types")?.externalRefs, 2);
    assert.equal(refs.get("time-types")?.localRefs, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregateGraph: reads coverage reports into files and symbol ranges", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-coverage-"));
  try {
    const rel = "src/service.js";
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, rel),
      [
        "export function covered() {",
        "  const a = 1",
        "  return a",
        "}",
        "export function missed() {",
        "  const b = 2",
        "  return b",
        "}"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(root, "coverage", "coverage-summary.json"),
      JSON.stringify({
        total: { lines: { total: 4, covered: 2, pct: 50 } },
        [rel]: { lines: { total: 4, covered: 2, pct: 50 } }
      }),
      "utf8"
    );
    writeFileSync(
      join(root, "coverage", "coverage-final.json"),
      JSON.stringify({
        [join(root, rel)]: {
          path: join(root, rel),
          statementMap: {
            "0": { start: { line: 2 }, end: { line: 2 } },
            "1": { start: { line: 3 }, end: { line: 3 } },
            "2": { start: { line: 6 }, end: { line: 6 } },
            "3": { start: { line: 7 }, end: { line: 7 } }
          },
          s: { "0": 1, "1": 1, "2": 0, "3": 0 }
        }
      }),
      "utf8"
    );

    const result = aggregateGraph(
      {
        nodes: [
          { id: "file", file_type: "code", source_file: rel },
          { id: "covered", file_type: "code", source_file: rel, label: "covered", source_location: "L1" },
          { id: "missed", file_type: "code", source_file: rel, label: "missed", source_location: "L5" }
        ],
        links: [
          { source: "file", target: "covered", relation: "contains" },
          { source: "file", target: "missed", relation: "contains" },
          { source: "covered", target: "missed", relation: "call" }
        ]
      },
      root
    );

    assert.equal(result.modules[0].files[0].coverage, 0.5);
    const symbols = new Map(result.symbols.map((symbol) => [symbol.id, symbol]));
    assert.equal(symbols.get("covered").coverage, 1);
    assert.equal(symbols.get("missed").coverage, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graphOutDir helpers place graphs in the sibling weavatrix-graphs folder", () => {
  assert.equal(repoBaseName("C:/work/my-repo"), "my-repo");
  assert.equal(
    graphOutDirForRepo(join("C:", "work", "my-repo")),
    join("C:", "work", "weavatrix-graphs", "my-repo")
  );
  assert.equal(
    graphOutDirForModule(join("C:", "work", "my-repo"), "src/api"),
    join("C:", "work", "weavatrix-graphs", "my-repo", "modules", "src_api")
  );
});
