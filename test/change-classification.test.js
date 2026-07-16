import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyChangeImpact, parseZeroContextDiff } from "../src/analysis/change-classification.js";

const fileNode = (file) => ({ id: file, source_file: file, file_type: "code" });
const symbolNode = (file, name, start, end, extra = {}) => ({
  id: `${file}#${name}@${start}`,
  label: `${name}()`,
  source_file: file,
  source_location: `L${start}`,
  source_end: `L${end}`,
  file_type: "code",
  ...extra,
});

const apiGraph = () => ({
  nodes: [
    fileNode("src/api.ts"),
    symbolNode("src/api.ts", "legacyApi", 1, 4, { exported: true }),
    symbolNode("src/api.ts", "useRetentionPolicy", 10, 14, { exported: true }),
    fileNode("src/consumer.ts"),
    symbolNode("src/consumer.ts", "render", 1, 3),
  ],
  links: [
    { source: "src/api.ts", target: "src/api.ts#legacyApi@1", relation: "contains" },
    { source: "src/api.ts", target: "src/api.ts#useRetentionPolicy@10", relation: "contains" },
    { source: "src/consumer.ts", target: "src/api.ts", relation: "imports" },
  ],
});

test("zero-context parser retains exact added/removed coordinates and rename metadata", () => {
  const parsed = parseZeroContextDiff([
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -2,2 +2,2 @@",
    "-oldOne();",
    "-oldTwo();",
    "+newOne();",
    "+newTwo();",
  ].join("\n"));
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].renamed, true);
  assert.equal(parsed.files[0].oldPath, "src/old.ts");
  assert.equal(parsed.files[0].newPath, "src/new.ts");
  assert.deepEqual(parsed.files[0].removals.map((line) => [line.oldLine, line.mappedNewLine]), [[2, 2], [3, 2]]);
  assert.deepEqual(parsed.files[0].additions.map((line) => line.newLine), [2, 3]);
});

test("zero-context parser does not confuse changed code beginning with ++/-- for file headers", () => {
  const parsed = parseZeroContextDiff([
    "diff --git a/src/math.ts b/src/math.ts", "--- a/src/math.ts", "+++ b/src/math.ts", "@@ -2 +2 @@",
    "---counter;", "+++counter;",
  ].join("\n"));
  assert.equal(parsed.files[0].removals[0].text, "--counter;");
  assert.equal(parsed.files[0].additions[0].text, "++counter;");
});

test("pure additive retention-policy export is LOW risk with zero legacy API/importer seeds", () => {
  const diffText = [
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -4,0 +10,5 @@",
    "+export function useRetentionPolicy(value) {",
    "+  const retained = value?.retained ?? false;",
    "+  if (!retained) return null;",
    "+  return { retained };",
    "+}",
  ].join("\n");
  const result = classifyChangeImpact({ graph: apiGraph(), diffText });
  assert.equal(result.verdict, "LOW");
  assert.deepEqual(result.seedIds, [], "new exported symbol must not seed api.ts and flood legacy importers");
  assert.equal(result.files[0].classification, "added");
  assert.equal(result.files[0].symbols.length, 1);
  assert.equal(result.files[0].symbols[0].id, "src/api.ts#useRetentionPolicy@10");
  assert.equal(result.files[0].symbols[0].classification, "added");
  assert.deepEqual(result.files[0].symbols[0].seedIds, []);
  assert.ok(!result.seedIds.includes("src/api.ts"));
  assert.ok(!result.seedIds.includes("src/consumer.ts"));
});

test("body change seeds only the mapped symbol and is MEDIUM", () => {
  const graph = {
    nodes: [fileNode("src/calc.ts"), symbolNode("src/calc.ts", "calculate", 1, 5, { exported: true })],
    links: [{ source: "src/calc.ts", target: "src/calc.ts#calculate@1", relation: "contains" }],
  };
  const diffText = [
    "diff --git a/src/calc.ts b/src/calc.ts", "--- a/src/calc.ts", "+++ b/src/calc.ts", "@@ -3 +3 @@",
    "-  return input * 2;", "+  return input * 3;",
  ].join("\n");
  const result = classifyChangeImpact({ graph, diffText });
  assert.equal(result.verdict, "MEDIUM");
  assert.equal(result.files[0].classification, "body-changed");
  assert.deepEqual(result.seedIds, ["src/calc.ts#calculate@1"]);
});

test("exported signature change seeds the symbol and containing file", () => {
  const graph = {
    nodes: [fileNode("src/calc.ts"), symbolNode("src/calc.ts", "calculate", 1, 5, { exported: true })],
    links: [{ source: "src/calc.ts", target: "src/calc.ts#calculate@1", relation: "contains" }],
  };
  const diffText = [
    "diff --git a/src/calc.ts b/src/calc.ts", "--- a/src/calc.ts", "+++ b/src/calc.ts", "@@ -1 +1 @@",
    "-export function calculate(input) {", "+export function calculate(input, multiplier) {",
  ].join("\n");
  const result = classifyChangeImpact({ graph, diffText });
  assert.equal(result.verdict, "HIGH");
  assert.equal(result.files[0].symbols[0].classification, "signature-changed");
  assert.deepEqual(result.seedIds, ["src/calc.ts", "src/calc.ts#calculate@1"]);
});

test("multiline parameter edits are signature changes, not body changes", () => {
  const graph = {
    nodes: [fileNode("src/calc.ts"), symbolNode("src/calc.ts", "calculate", 1, 8, { exported: true })],
    links: [],
  };
  const diffText = [
    "diff --git a/src/calc.ts b/src/calc.ts", "--- a/src/calc.ts", "+++ b/src/calc.ts", "@@ -2 +2 @@",
    "-  input: number,", "+  input: number | null,",
  ].join("\n");
  const result = classifyChangeImpact({ graph, diffText });
  assert.equal(result.files[0].classification, "signature-changed");
  assert.deepEqual(result.seedIds, ["src/calc.ts", "src/calc.ts#calculate@1"]);
});

test("removed declaration maps through old coordinates and seeds stale graph identity", () => {
  const graph = {
    nodes: [fileNode("src/legacy.ts"), symbolNode("src/legacy.ts", "legacyHook", 1, 3, { exported: true })],
    links: [{ source: "src/legacy.ts", target: "src/legacy.ts#legacyHook@1", relation: "contains" }],
  };
  const diffText = [
    "diff --git a/src/legacy.ts b/src/legacy.ts", "--- a/src/legacy.ts", "+++ b/src/legacy.ts", "@@ -1,3 +0,0 @@",
    "-export function legacyHook() {", "-  return true;", "-}",
  ].join("\n");
  const result = classifyChangeImpact({ graph, diffText });
  assert.equal(result.verdict, "HIGH");
  assert.equal(result.files[0].classification, "removed");
  assert.equal(result.files[0].symbols[0].classification, "removed");
  assert.deepEqual(result.seedIds, ["src/legacy.ts", "src/legacy.ts#legacyHook@1"]);
});

test("comment-only hunks are metadata-only and do not seed dependents", () => {
  const graph = { nodes: [fileNode("src/calc.ts"), symbolNode("src/calc.ts", "calculate", 1, 5)], links: [] };
  const diffText = [
    "diff --git a/src/calc.ts b/src/calc.ts", "--- a/src/calc.ts", "+++ b/src/calc.ts", "@@ -2 +2 @@",
    "-  // double the input", "+  // multiply the input",
  ].join("\n");
  const result = classifyChangeImpact({ graph, diffText });
  assert.equal(result.verdict, "LOW");
  assert.equal(result.files[0].classification, "metadata-only");
  assert.deepEqual(result.seedIds, []);
});

test("test and e2e file changes are labelled test-only instead of unknown", () => {
  const graph = {
    nodes: [
      fileNode("test-e2e/cypress/e2e/login.cy.ts"),
      symbolNode("test-e2e/cypress/e2e/login.cy.ts", "loginFlow", 1, 6),
    ],
    links: [],
  };
  const diffText = [
    "diff --git a/test-e2e/cypress/e2e/login.cy.ts b/test-e2e/cypress/e2e/login.cy.ts",
    "--- a/test-e2e/cypress/e2e/login.cy.ts",
    "+++ b/test-e2e/cypress/e2e/login.cy.ts",
    "@@ -5 +5 @@",
    "-mysteryHarness(oldValue);",
    "+mysteryHarness(newValue);",
  ].join("\n");
  const result = classifyChangeImpact({ graph, diffText });
  assert.equal(result.verdict, "LOW");
  assert.equal(result.files[0].classification, "test-only");
  assert.equal(result.files[0].changeClassification, "body-changed");
  assert.deepEqual(result.files[0].pathClasses, ["test", "e2e"]);
  assert.deepEqual(result.seedIds, []);
  assert.equal(result.summary.counts["test-only"], 1);
});

test("files-only fallback retains conservative verdict but identifies test-only surface", () => {
  const graph = {nodes: [fileNode("src/auth.test.ts")], links: []};
  const result = classifyChangeImpact({ graph, files: ["src/auth.test.ts"] });
  assert.equal(result.verdict, "HIGH", "missing diff evidence remains conservative");
  assert.equal(result.files[0].classification, "test-only");
  assert.equal(result.files[0].changeClassification, "unknown");
  assert.deepEqual(result.seedIds, []);
});

test("rename, binary, files-only and oversized evidence are conservative HIGH", () => {
  const graph = {
    nodes: [fileNode("src/new.ts"), symbolNode("src/new.ts", "api", 1, 3, { exported: true })],
    links: [],
  };
  const renamed = classifyChangeImpact({ graph, diffText: [
    "diff --git a/src/old.ts b/src/new.ts", "similarity index 100%", "rename from src/old.ts", "rename to src/new.ts",
  ].join("\n") });
  assert.equal(renamed.verdict, "HIGH");
  assert.equal(renamed.files[0].classification, "signature-changed");
  assert.deepEqual(renamed.seedIds, ["src/new.ts"]);

  const binary = classifyChangeImpact({ graph, diffText: [
    "diff --git a/src/new.ts b/src/new.ts", "Binary files a/src/new.ts and b/src/new.ts differ",
  ].join("\n") });
  assert.equal(binary.verdict, "HIGH");
  assert.equal(binary.files[0].classification, "unknown");
  assert.deepEqual(binary.seedIds, ["src/new.ts", "src/new.ts#api@1"]);

  const unavailable = classifyChangeImpact({ graph, files: ["src/new.ts"] });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.verdict, "HIGH");
  assert.equal(unavailable.files[0].classification, "unknown");
  assert.deepEqual(unavailable.seedIds, ["src/new.ts", "src/new.ts#api@1"]);

  const oversizedText = [
    "diff --git a/src/new.ts b/src/new.ts", "--- a/src/new.ts", "+++ b/src/new.ts", "@@ -2 +2,200 @@",
    ...Array.from({ length: 200 }, (_, index) => `+const generated_${index} = ${index}; // ${"x".repeat(20)}`),
  ].join("\n");
  const oversized = classifyChangeImpact({ graph, diffText: oversizedText, limits: { maxDiffBytes: 1024 } });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.verdict, "HIGH");
  assert.equal(oversized.bounds.truncated, true);
  assert.equal(oversized.files[0].classification, "unknown");
  assert.deepEqual(oversized.seedIds, ["src/new.ts", "src/new.ts#api@1"]);
});

test("new files are additive LOW even before the graph knows them", () => {
  const result = classifyChangeImpact({ graph: { nodes: [], links: [] }, diffText: [
    "diff --git a/src/new-hook.ts b/src/new-hook.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new-hook.ts", "@@ -0,0 +1,2 @@",
    "+export const useNewHook = () => true;", "+export default useNewHook;",
  ].join("\n") });
  assert.equal(result.verdict, "LOW");
  assert.equal(result.files[0].classification, "added");
  assert.deepEqual(result.seedIds, []);
});

test("repoRoot + base obtains a bounded zero-context diff from git", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-change-classify-"));
  try {
    execFileSync("git", ["init", "-q", repo], { windowsHide: true });
    execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.test"], { windowsHide: true });
    execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"], { windowsHide: true });
    writeFileSync(join(repo, "calc.ts"), "export function calculate(input) {\n  return input * 2;\n}\n");
    execFileSync("git", ["-C", repo, "add", "calc.ts"], { windowsHide: true });
    execFileSync("git", ["-C", repo, "commit", "-qm", "baseline"], { windowsHide: true });
    writeFileSync(join(repo, "calc.ts"), "export function calculate(input) {\n  return input * 3;\n}\n");
    const graph = { nodes: [fileNode("calc.ts"), symbolNode("calc.ts", "calculate", 1, 3, { exported: true })], links: [] };
    const result = classifyChangeImpact({ repoRoot: repo, graph, base: "HEAD" });
    assert.equal(result.ok, true);
    assert.equal(result.source, "git-diff");
    assert.equal(result.verdict, "MEDIUM");
    assert.deepEqual(result.seedIds, ["calc.ts#calculate@1"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
