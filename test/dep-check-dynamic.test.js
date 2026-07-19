import test from "node:test";
import assert from "node:assert/strict";
import { computeDepFindings } from "../src/analysis/dep-check.js";

const unused = (result) => result.findings.filter((finding) => finding.rule === "unused-dep");

test("dep-check: dynamic package-path literals are package usage evidence", () => {
  const result = computeDepFindings({
    pkg: {
      dependencies: { "tree-sitter-wasms": "^0.1" },
      devDependencies: { "@anthropic-ai/mcpb": "^0.3", "typescript-language-server": "^5" },
    },
    sourceTexts: new Map([
      ["src/wasm.js", `join(root, "node_modules", "tree-sitter-wasms", grammar)`],
      ["src/package.js", `join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli.js")`],
      ["src/lsp.js", `resolveCli("typescript-language-server")`],
    ]),
  });
  assert.deepEqual(unused(result), []);
});

test("dep-check: manifest declarations are not source usage", () => {
  const result = computeDepFindings({
    pkg: { dependencies: { "unused-control": "1.0.0" } },
    sourceTexts: new Map([["package.json", `{"dependencies":{"unused-control":"1.0.0"}}`]]),
  });
  assert.deepEqual(unused(result).map((finding) => finding.package), ["unused-control"]);
});

test("dep-check: unused declarations point at the owning manifest", () => {
  const result = computeDepFindings({
    pkg: { dependencies: { unused: "^1" } },
    manifest: "benchmarks/fixtures/package.json",
  });
  const finding = unused(result)[0];
  assert.equal(finding.file, "benchmarks/fixtures/package.json");
  assert.deepEqual(finding.evidence, [{ file: "benchmarks/fixtures/package.json", line: 0, snippet: "declared in dependencies" }]);
});
