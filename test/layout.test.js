import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTestPath,
  filterGraphForMode,
  filterGraphByScope,
  graphOutDirForRepo,
  graphOutDirForModule
} from "../src/graph/layout.js";
import { repoBaseName } from "../src/scan/discover.js";
import { join } from "node:path";

test("isTestPath: recognises common test file conventions", () => {
  assert.equal(isTestPath("src/foo.test.js"), true);
  assert.equal(isTestPath("src/__tests__/foo.js"), true);
  assert.equal(isTestPath("tests/foo.js"), true);
  assert.equal(isTestPath("pkg/foo_test.go"), true);
  assert.equal(isTestPath("pkg/test_thing.py"), true);
  assert.equal(isTestPath("test-e2e/cypress/e2e/login.cy.ts"), true);
  assert.equal(isTestPath("apps/web/playwright/login.spec.ts"), true);
  assert.equal(isTestPath("acceptance-tests/auth/login.ts"), true);
});

test("isTestPath: leaves production paths alone", () => {
  assert.equal(isTestPath("src/foo.js"), false);
  assert.equal(isTestPath("src/contestant.js"), false); // 'test' inside a word must not match
});

const graph = () => ({
  nodes: [
    { id: "a", source_file: "src/a.js" },
    { id: "b", source_file: "src/b.js" },
    { id: "t", source_file: "src/a.test.js" },
    { id: "e", source_file: "test-e2e/cypress/e2e/login.cy.ts" }
  ],
  links: [
    { source: "t", target: "a" }, // a test depending on production code
    { source: "e", target: "b" },
    { source: "a", target: "b" }
  ]
});

test("filterGraphForMode: 'full' (or unknown) returns the graph unchanged", () => {
  const g = graph();
  assert.equal(filterGraphForMode(g, "full"), g);
});

test("filterGraphForMode: 'no-tests' drops test nodes and links touching them", () => {
  const input = graph();
  input.externalImports = [
    { file: "src/a.js", spec: "react" },
    { file: "test-e2e/cypress/e2e/login.cy.ts", spec: "cypress" }
  ];
  const g = filterGraphForMode(input, "no-tests");
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["a", "b"]);
  assert.deepEqual(g.links, [{ source: "a", target: "b" }]);
  assert.deepEqual(g.externalImports, [{ file: "src/a.js", spec: "react" }]);
});

test("filterGraphForMode: 'tests-only' keeps tests plus their direct dependencies", () => {
  const g = filterGraphForMode(graph(), "tests-only");
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["a", "b", "e", "t"]);
  assert.deepEqual(g.links, [
    { source: "t", target: "a" },
    { source: "e", target: "b" },
    { source: "a", target: "b" }
  ]);
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

test("filterGraphForMode: 'tests-only' prunes external imports from unrelated production files", () => {
  const g = filterGraphForMode({
    nodes: [
      { id: "t", source_file: "test-e2e/login.ts" },
      { id: "a", source_file: "src/a.js" },
      { id: "z", source_file: "src/unrelated.js" }
    ],
    links: [{ source: "t", target: "a" }],
    externalImports: [
      { file: "test-e2e/login.ts", spec: "cypress" },
      { file: "src/a.js", spec: "react" },
      { file: "src/unrelated.js", spec: "lodash" }
    ]
  }, "tests-only");
  assert.deepEqual(g.externalImports.map((item) => item.spec), ["cypress", "react"]);
});

test("filterGraphByScope: keeps only nodes under the prefix and prunes dangling links", () => {
  const g = filterGraphByScope(
    {
      nodes: [
        { id: "x", source_file: "src/api/x.js" },
        { id: "y", source_file: "src/web/y.js" }
      ],
      links: [{ source: "x", target: "y" }],
      externalImports: [
        { file: "src/api/x.js", spec: "express" },
        { file: "src/web/y.js", spec: "react" }
      ]
    },
    "src/api"
  );
  assert.deepEqual(g.nodes.map((n) => n.id), ["x"]);
  assert.deepEqual(g.links, []);
  assert.deepEqual(g.externalImports, [{ file: "src/api/x.js", spec: "express" }]);
});

test("filterGraphByScope: normalises backslash paths before matching", () => {
  const g = filterGraphByScope(
    { nodes: [{ id: "x", source_file: "src\\api\\x.js" }], links: [] },
    "src/api"
  );
  assert.deepEqual(g.nodes.map((n) => n.id), ["x"]);
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
