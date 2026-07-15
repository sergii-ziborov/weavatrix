import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectCoverage, normalizeRepoRoot } from "../src/tools/coverage.js";

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-cov-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function pkgJson(extra = {}) {
  return JSON.stringify({ name: "fixture", version: "1.0.0", ...extra });
}

// ---- JS: vitest / jest -------------------------------------------------------------------------

test("detectCoverage: vitest devDependency → vitest plan with lcov reporter", () => {
  const dir = makeRepo({ "package.json": pkgJson({ devDependencies: { vitest: "^1.0.0" } }) });
  try {
    const plan = detectCoverage(dir);
    assert.equal(plan.stack, "vitest");
    assert.equal(plan.report, "coverage/lcov.info");
    assert.equal(plan.steps[0][0], "npx");
    assert.ok(plan.steps[0][1].includes("vitest"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: jest via test script (no dep entry) → jest plan", () => {
  const dir = makeRepo({ "package.json": pkgJson({ scripts: { test: "jest --runInBand" } }) });
  try {
    const plan = detectCoverage(dir);
    assert.equal(plan.stack, "jest");
    assert.equal(plan.report, "coverage/lcov.info");
    assert.ok(plan.steps[0][1].includes("--coverage"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: vitest wins over jest when both are present", () => {
  const dir = makeRepo({ "package.json": pkgJson({ devDependencies: { vitest: "^1.0.0", jest: "^29.0.0" } }) });
  try {
    assert.equal(detectCoverage(dir).stack, "vitest");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- JS: node --test (weavatrix's own stack) ----------------------------------------------------

test("detectCoverage: \"test\": \"node --test\" → node-test plan writing lcov.info", () => {
  const dir = makeRepo({ "package.json": pkgJson({ scripts: { test: "node --test" } }) });
  try {
    const plan = detectCoverage(dir);
    assert.equal(plan.stack, "node-test");
    assert.equal(plan.report, "lcov.info");
    const [cmd, args] = plan.steps[0];
    assert.equal(cmd, "node");
    assert.ok(args.includes("--test"));
    assert.ok(args.includes("--experimental-test-coverage"));
    assert.ok(args.includes("--test-reporter=lcov"));
    assert.ok(args.includes("--test-reporter-destination=lcov.info"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: node --test keeps the script's positional test roots", () => {
  const dir = makeRepo({ "package.json": pkgJson({ scripts: { test: "node --test test/ tests/unit" } }) });
  try {
    const args = detectCoverage(dir).steps[0][1];
    assert.ok(args.includes("test/"));
    assert.ok(args.includes("tests/unit"));
    assert.ok(!args.includes("--watch"), "script flags are replaced by our coverage flags");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: node --test keeps loader flags with values; other flag values don't leak as paths", () => {
  const dir = makeRepo({ "package.json": pkgJson({ scripts: { test: "node --import tsx --test-reporter spec --test --watch test/" } }) });
  try {
    const args = detectCoverage(dir).steps[0][1];
    assert.equal(args[args.indexOf("--import") + 1], "tsx", "loader flag+value preserved");
    assert.ok(args.includes("test/"), "positional root kept");
    assert.ok(!args.includes("--watch"), "non-loader flags dropped");
    assert.ok(!args.includes("spec"), "reporter VALUE must not leak as a test path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: a jest dep beats a node --test script (more specific runner first)", () => {
  const dir = makeRepo({ "package.json": pkgJson({ devDependencies: { jest: "^29.0.0" }, scripts: { test: "node --test" } }) });
  try {
    assert.equal(detectCoverage(dir).stack, "jest");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: unsupported JS runners like mocha are not misdetected", () => {
  const dir = makeRepo({ "package.json": pkgJson({ scripts: { test: "mocha" } }) });
  try {
    assert.equal(detectCoverage(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Go ------------------------------------------------------------------------------------------

test("detectCoverage: go.mod + *_test.go → go plan with coverprofile", () => {
  const dir = makeRepo({
    "go.mod": "module example.com/demo\n\ngo 1.22\n",
    "main.go": "package main\nfunc main() {}\n",
    "main_test.go": "package main\nimport \"testing\"\nfunc TestMain(t *testing.T) {}\n"
  });
  try {
    const plan = detectCoverage(dir);
    assert.equal(plan.stack, "go");
    assert.equal(plan.report, "coverage.out");
    assert.deepEqual(plan.steps[0], ["go", ["test", "./...", "-coverprofile=coverage.out"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: a Go repo with an unrelated package.json still detects go (fall-through)", () => {
  const dir = makeRepo({
    "package.json": pkgJson({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }),
    "go.mod": "module example.com/demo\n\ngo 1.22\n"
  });
  try {
    assert.equal(detectCoverage(dir).stack, "go");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Python / pytest -----------------------------------------------------------------------------

test("detectCoverage: pytest.ini → python plan exporting lcov", () => {
  const dir = makeRepo({ "pytest.ini": "[pytest]\n" });
  try {
    const plan = detectCoverage(dir);
    assert.equal(plan.stack, "python");
    assert.equal(plan.report, "lcov.info");
    assert.equal(plan.steps.length, 2, "coverage run -m pytest, then coverage lcov");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: pyproject.toml with [tool.pytest.ini_options] → python plan", () => {
  const dir = makeRepo({ "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n" });
  try {
    assert.equal(detectCoverage(dir).stack, "python");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: requirements.txt alone → python plan", () => {
  const dir = makeRepo({ "requirements.txt": "pytest\n" });
  try {
    assert.equal(detectCoverage(dir).stack, "python");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: NO manifest, only tests/test_*.py → python plan (pytest file convention)", () => {
  const dir = makeRepo({ "tests/test_smoke.py": "def test_ok():\n    assert True\n" });
  try {
    assert.equal(detectCoverage(dir).stack, "python");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- nothing detected / hardening ----------------------------------------------------------------

test("detectCoverage: empty repo → null; missing path → null", () => {
  const dir = makeRepo({ "README.md": "# nothing here\n" });
  try {
    assert.equal(detectCoverage(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(detectCoverage(join(tmpdir(), "weavatrix-cov-does-not-exist")), null);
  assert.equal(detectCoverage(""), null);
  assert.equal(detectCoverage(null), null);
});

test("detectCoverage: messy caller paths (trailing separator, whitespace, quotes, file://) still detect", () => {
  const dir = makeRepo({ "go.mod": "module example.com/demo\n" });
  try {
    assert.equal(detectCoverage(`${dir}\\`).stack, "go", "trailing backslash");
    assert.equal(detectCoverage(`${dir}//`).stack, "go", "trailing slashes");
    assert.equal(detectCoverage(`  ${dir}  `).stack, "go", "surrounding whitespace");
    assert.equal(detectCoverage(`"${dir}"`).stack, "go", "wrapping quotes");
    assert.equal(detectCoverage(`file://${dir}`).stack, "go", "file:// prefix");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: package.json with a UTF-8 BOM still detects (Windows-authored files)", () => {
  const dir = makeRepo({ "package.json": "﻿" + pkgJson({ scripts: { test: "node --test" } }) });
  try {
    assert.equal(detectCoverage(dir).stack, "node-test");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: unparseable package.json falls through to other stacks", () => {
  const dir = makeRepo({ "package.json": "{ not json", "go.mod": "module example.com/demo\n" });
  try {
    assert.equal(detectCoverage(dir).stack, "go");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeRepoRoot: keeps drive roots intact, strips noise everywhere else", () => {
  assert.equal(normalizeRepoRoot("C:\\"), "C:\\", "drive root must not become drive-relative C:");
  assert.equal(normalizeRepoRoot("C:\\repo\\"), "C:\\repo");
  assert.equal(normalizeRepoRoot(' "C:\\repo" '), "C:\\repo");
  assert.equal(normalizeRepoRoot(null), "");
});
