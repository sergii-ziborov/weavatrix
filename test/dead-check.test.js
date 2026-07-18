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

test("computeDead: Cargo crate roots and build scripts are framework entry files", () => {
  const symbols = new Map([
    ["native/build.rs", "build_only"], ["native/src/lib.rs", "lib_only"],
    ["native/src/main.rs", "main_only"], ["native/src/orphan.rs", "orphan_only"],
  ]);
  const files = [...symbols.keys()];
  const nodes = files.flatMap((file) => [
    { id: file, source_file: file },
    { id: `${file}#${symbols.get(file)}@1`, label: `${symbols.get(file)}()`, source_file: file },
  ]);
  const links = files.map((file) => ({ source: file, target: `${file}#${symbols.get(file)}@1`, relation: "contains" }));
  const sources = new Map(files.map((file) => [file, `fn ${symbols.get(file)}() {}`]));
  const dead = new Set(computeDead({ nodes, links }, sources).deadFiles.map((finding) => finding.file));
  assert.ok(!dead.has("native/build.rs"));
  assert.ok(!dead.has("native/src/lib.rs"));
  assert.ok(!dead.has("native/src/main.rs"));
  assert.ok(dead.has("native/src/orphan.rs"));
});

test("computeDead: Java method ownership is structural, not an inbound usage", () => {
  const graph = {
    nodes: [
      { id: "Child.java", source_file: "Child.java" },
      { id: "Child.java#Child@1", label: "Child", source_file: "Child.java" },
      { id: "Child.java#deadUniqueName@2", label: "deadUniqueName()", source_file: "Child.java" },
    ],
    links: [
      { source: "Child.java", target: "Child.java#Child@1", relation: "contains" },
      { source: "Child.java", target: "Child.java#deadUniqueName@2", relation: "contains" },
      { source: "Child.java#Child@1", target: "Child.java#deadUniqueName@2", relation: "method" },
    ],
  };
  const result = computeDead(graph, new Map([["Child.java", "class Child {\n  void deadUniqueName() {}\n}\n"]]));
  assert.ok(result.deadSymbols.some((symbol) => symbol.id === "Child.java#deadUniqueName@2"));
});

test("computeDead: a local production use prevents a same-named test occurrence from becoming test-only evidence", () => {
  const target = { id: "src/context.js#USER_HEADER@1", label: "USER_HEADER", source_file: "src/context.js" };
  const graph = {
    nodes: [
      { id: "src/context.js", source_file: "src/context.js" },
      target,
      { id: "test/context.test.js", source_file: "test/context.test.js" },
    ],
    links: [{ source: "src/context.js", target: target.id, relation: "contains" }],
  };
  const sources = new Map([
    ["src/context.js", "const USER_HEADER = 'x-user';\nexport function read(request) { return request.headers.get(USER_HEADER); }\n"],
    ["test/context.test.js", "const USER_HEADER = 'fixture';\n"],
  ]);
  const result = computeDead(graph, sources);
  assert.equal(result.deadSymbols.some((symbol) => symbol.id === target.id), false);
  assert.equal(result.testOnlySymbols.some((symbol) => symbol.id === target.id), false);
});

test("computeDead: revision-bound exact reference evidence keeps a symbol out of the dead queue", () => {
  const target = { id: "src/context.js#USER_HEADER@1", label: "USER_HEADER", source_file: "src/context.js" };
  const graph = {
    nodes: [{ id: "src/context.js", source_file: "src/context.js" }, target],
    links: [{ source: "src/context.js", target: target.id, relation: "contains" }],
    precisionReferenceSymbols: [target.id],
    precisionProductionReferenceSymbols: [target.id],
  };
  const result = computeDead(graph, new Map([["src/context.js", "const USER_HEADER = 'x-user';\n"]]));
  assert.equal(result.deadSymbols.some((symbol) => symbol.id === target.id), false);
  assert.equal(result.testOnlySymbols.some((symbol) => symbol.id === target.id), false);
});
