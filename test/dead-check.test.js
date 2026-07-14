import test from "node:test";
import assert from "node:assert/strict";
import { computeDead } from "../src/analysis/dead-check.js";

test("computeDead: a symbol referenced BY NAME in another file is not dead (cross-file, no edge)", () => {
  const graph = {
    nodes: [
      { id: "a.go", file_type: "code", source_file: "a.go" },
      { id: "a.go#FOO@1", label: "FOO", source_file: "a.go" },
      { id: "a.go#bar@2", label: "bar()", source_file: "a.go" },
      { id: "b.go", file_type: "code", source_file: "b.go" },
    ],
    links: [
      { source: "a.go", target: "a.go#FOO@1", relation: "contains" },
      { source: "a.go", target: "a.go#bar@2", relation: "contains" },
    ],
  };
  const sources = new Map([
    ["a.go", "const FOO = 1\nfunc bar() {}\n"],
    ["b.go", "x := FOO\n"], // FOO used cross-file, no graph edge
  ]);
  const dead = new Set(computeDead(graph, sources).deadSymbols.map((s) => s.id));
  assert.equal(dead.has("a.go#FOO@1"), false, "FOO used in b.go → alive");
  assert.equal(dead.has("a.go#bar@2"), true, "bar unreferenced anywhere → dead");
});

test("computeDead: an inbound edge keeps a symbol alive even if its name is unreferenced in text", () => {
  const graph = {
    nodes: [{ id: "x.js", source_file: "x.js" }, { id: "x.js#run@1", label: "run()", source_file: "x.js" }],
    links: [
      { source: "x.js", target: "x.js#run@1", relation: "contains" },
      { source: "y.js#main@1", target: "x.js#run@1", relation: "calls" },
    ],
  };
  assert.equal(computeDead(graph, new Map([["x.js", "function run(){}"]])).deadSymbols.length, 0);
});

test("computeDead: a file that's not imported and whose symbols are all dead is a dead file (entry files exempt)", () => {
  const graph = {
    nodes: [
      { id: "orphan.js", source_file: "orphan.js" },
      { id: "orphan.js#helper@1", label: "helper()", source_file: "orphan.js" },
      { id: "main.js", source_file: "main.js" },
      { id: "main.js#boot@1", label: "boot()", source_file: "main.js" },
    ],
    links: [
      { source: "orphan.js", target: "orphan.js#helper@1", relation: "contains" },
      { source: "main.js", target: "main.js#boot@1", relation: "contains" },
    ],
  };
  const sources = new Map([["orphan.js", "function helper(){}"], ["main.js", "function boot(){}"]]);
  const r = computeDead(graph, sources);
  const deadFiles = new Set(r.deadFiles.map((f) => f.file));
  assert.equal(deadFiles.has("orphan.js"), true, "orphan not imported + helper dead → dead file");
  assert.equal(deadFiles.has("main.js"), false, "main.js is an entry file → never dead");
});
