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
