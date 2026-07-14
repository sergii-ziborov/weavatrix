// specToPkg — the import-specifier → package-name primitive for dependency analysis (P0 of
// DEPS_SECURITY_PLAN.md). Relative/URL specifiers are null; node: prefix and bare builtins are
// flagged builtin; scoped packages keep @scope/name and drop the subpath.
import { test } from "node:test";
import assert from "node:assert/strict";
import { specToPkg, NODE_BUILTINS, goSpecToPkg, pySpecToPkg } from "../src/graph/builder/spec-pkg.js";

test("specToPkg: relative, absolute and URL specifiers are not packages", () => {
  assert.equal(specToPkg("./x"), null);
  assert.equal(specToPkg("../lib/util.js"), null);
  assert.equal(specToPkg("/abs/path"), null);
  assert.equal(specToPkg("C:\\code\\x.js"), null);
  assert.equal(specToPkg("https://esm.sh/react"), null);
  assert.equal(specToPkg("data:text/javascript,export default 1"), null);
  assert.equal(specToPkg(""), null);
  assert.equal(specToPkg(null), null);
});

test("specToPkg: bare packages strip subpaths; scoped keep @scope/name", () => {
  assert.deepEqual(specToPkg("axios"), { pkg: "axios", builtin: false });
  assert.deepEqual(specToPkg("axios/lib/core"), { pkg: "axios", builtin: false });
  assert.deepEqual(specToPkg("@scope/name"), { pkg: "@scope/name", builtin: false });
  assert.deepEqual(specToPkg("@scope/name/deep/sub"), { pkg: "@scope/name", builtin: false });
  assert.deepEqual(specToPkg("lodash.merge"), { pkg: "lodash.merge", builtin: false });
});

test("specToPkg: node builtins — bare, subpath, and node: prefix", () => {
  assert.deepEqual(specToPkg("fs"), { pkg: "fs", builtin: true });
  assert.deepEqual(specToPkg("fs/promises"), { pkg: "fs", builtin: true });
  assert.deepEqual(specToPkg("node:fs"), { pkg: "fs", builtin: true });
  assert.deepEqual(specToPkg("node:fs/promises"), { pkg: "fs", builtin: true });
  assert.deepEqual(specToPkg("node:test"), { pkg: "test", builtin: true }); // prefix-only builtin
});

test("specToPkg: prefix-only builtin names stay npm packages when bare", () => {
  // "test" and "sea" are real npm package names; only the node: prefix makes them builtins
  assert.deepEqual(specToPkg("test"), { pkg: "test", builtin: false });
  assert.equal(NODE_BUILTINS.has("test"), false);
});

test("specToPkg: bun:/npm:/other-scheme specifiers", () => {
  assert.deepEqual(specToPkg("bun:test"), { pkg: "bun:test", builtin: true }); // Bun runtime module — NOT a missing npm dep
  assert.deepEqual(specToPkg("bun"), { pkg: "bun", builtin: true });
  assert.deepEqual(specToPkg("npm:axios/lib/core"), { pkg: "axios", builtin: false });
  assert.equal(specToPkg("jsr:@std/path"), null);
  assert.equal(specToPkg("virtual:pwa-register"), null);
});

test("goSpecToPkg: stdlib is dotless-first-segment; requires prefix wins; host heuristics for the rest", () => {
  assert.deepEqual(goSpecToPkg("fmt", {}), { pkg: "fmt", builtin: true });
  assert.deepEqual(goSpecToPkg("net/http", {}), { pkg: "net/http", builtin: true });
  const requires = ["github.com/segmentio/kafka-go"];
  assert.deepEqual(goSpecToPkg("github.com/segmentio/kafka-go/sasl/plain", { requires }), { pkg: "github.com/segmentio/kafka-go", builtin: false });
  assert.deepEqual(goSpecToPkg("github.com/owner/repo/internal/x", {}), { pkg: "github.com/owner/repo", builtin: false });
  assert.deepEqual(goSpecToPkg("gopkg.in/yaml.v3", {}), { pkg: "gopkg.in/yaml.v3", builtin: false });
  assert.deepEqual(goSpecToPkg("k8s.io/client-go/kubernetes", {}), { pkg: "k8s.io/client-go", builtin: false });
  assert.equal(goSpecToPkg("github.com/acme/app/pkg/util", { ownModule: "github.com/acme/app" }), null); // own module → internal
});

test("pySpecToPkg: stdlib builtin; alias map; ambiguous namespace flagged", () => {
  assert.deepEqual(pySpecToPkg("os"), { pkg: "os", builtin: true });
  assert.deepEqual(pySpecToPkg("pathlib"), { pkg: "pathlib", builtin: true });
  assert.equal(pySpecToPkg("yaml").pkg, "PyYAML");
  assert.equal(pySpecToPkg("requests").pkg, "requests");
  assert.equal(pySpecToPkg("google").ambiguous, true);
});
