// Split from coverage-detect.test.js: bun coverage detection + bun script harvesting.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bunScriptTestFiles, detectCoverage } from "../src/tools/coverage.js";

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

// ---- JS: bun -------------------------------------------------------------------------------------

test("detectCoverage: bun test uses Bun's LCOV reporter", () => {
  const dir = makeRepo({ "package.json": pkgJson({ scripts: { test: "bun test" } }) });
  try {
    const plan = detectCoverage(dir);
    assert.equal(plan.stack, "bun");
    assert.equal(plan.report, "coverage/lcov.info");
    assert.deepEqual(plan.steps[0], ["bun", ["test", "--coverage", "--coverage-reporter=lcov"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: bun harvests explicit itest files from test scripts + keeps default-discovered files", () => {
  // edge-analytics shape: the real unit suite is *.itest.js run via an explicit file list — bun's
  // zero-arg discovery would silently skip ALL of it and report ~3% coverage.
  const dir = makeRepo({
    "package.json": pkgJson({
      scripts: {
        test: "bun test",
        "test:service": "bun test ./src/a/__test__/unit/a.service.itest.js ./src/b/__test__/unit/b.service.itest.js",
        "test:e2e": "bun test ./src/a/__test__/e2e/a.crud.e2e.js",
        "test:integration": "bun test ./src/a/__test__/integration/a.real-db.integration.js"
      }
    }),
    "src/a/__test__/unit/a.service.itest.js": "// itest",
    "src/b/__test__/unit/b.service.itest.js": "// itest",
    "src/a/__test__/e2e/a.crud.e2e.js": "// e2e",
    "src/a/__test__/integration/a.real-db.integration.js": "// integration",
    "src/a/a.shape.test.js": "// default-discovered"
  });
  try {
    const plan = detectCoverage(dir);
    assert.equal(plan.stack, "bun");
    const args = plan.steps[0][1];
    assert.ok(args.includes("./src/a/__test__/unit/a.service.itest.js"), "harvested itest file");
    assert.ok(args.includes("./src/b/__test__/unit/b.service.itest.js"), "harvested itest file (2nd script arg)");
    assert.ok(args.includes("./src/a/a.shape.test.js"), "default-discovered *.test.js kept — explicit paths turn bun discovery off");
    assert.ok(!args.some((a) => a.includes("e2e")), "e2e scripts need live infra — excluded");
    assert.ok(!args.some((a) => a.includes("integration")), "integration scripts need live infra — excluded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: bun harvest drops paths that don't exist on disk", () => {
  const dir = makeRepo({
    "package.json": pkgJson({
      scripts: { test: "bun test", "test:service": "bun test ./src/gone.itest.js ./src/here.itest.js" }
    }),
    "src/here.itest.js": "// itest"
  });
  try {
    const args = detectCoverage(dir).steps[0][1];
    assert.ok(args.includes("./src/here.itest.js"));
    assert.ok(!args.includes("./src/gone.itest.js"), "stale script entries must not break the bun run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: bun stays PLAIN when a repo has default tests but no harvestable scripts (pins the gate)", () => {
  const dir = makeRepo({
    "package.json": pkgJson({ scripts: { test: "bun test" } }),
    "src/a.test.js": "// default-discovered"
  });
  try {
    assert.deepEqual(detectCoverage(dir).steps[0], ["bun", ["test", "--coverage", "--coverage-reporter=lcov"]], "no harvest → bun's own discovery, no positional args");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: a harvest of ONLY glob/stale tokens must not switch off bun discovery", () => {
  // bun's shell expands globs at run time; our parser sees the literal token, which fails existsSync.
  // If nothing harvested survives, explicit-file mode must NOT activate.
  const dir = makeRepo({
    "package.json": pkgJson({ scripts: { test: "bun test", "test:unit": "bun test ./src/**/*.itest.ts" } }),
    "src/a.test.js": "// default-discovered"
  });
  try {
    assert.deepEqual(detectCoverage(dir).steps[0][1], ["test", "--coverage", "--coverage-reporter=lcov"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: bun falls back to plain + warn when the explicit list would blow the command-line limit", () => {
  const files = { "package.json": "" };
  const longName = "x".repeat(120);
  const scriptFiles = [];
  for (let i = 0; i < 60; i++) {
    const rel = `src/deep/${longName}-${i}.itest.js`;
    files[rel] = "// itest";
    scriptFiles.push(`./${rel}`);
  }
  files["package.json"] = pkgJson({ scripts: { test: "bun test", "test:service": `bun test ${scriptFiles.join(" ")}` } });
  files["src/a.test.js"] = "// default-discovered";
  const dir = makeRepo(files);
  try {
    const plan = detectCoverage(dir);
    assert.deepEqual(plan.steps[0][1], ["test", "--coverage", "--coverage-reporter=lcov"], "never silently truncate — plain discovery instead");
    assert.match(plan.warn, /test list too long/, "the fallback is surfaced, not silent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectCoverage: bun falls back to plain + warn when the default-test walk hits its cap", () => {
  // >400 default-pattern files → the parity walk can't guarantee bun-discovery parity, so explicit
  // mode must not activate (it would silently drop tests plain `bun test` runs).
  const files = {
    "package.json": pkgJson({ scripts: { test: "bun test", "test:service": "bun test ./src/one.itest.js" } }),
    "src/one.itest.js": "// itest"
  };
  for (let i = 0; i < 401; i++) files[`src/many/f${i}.test.js`] = "// t";
  const dir = makeRepo(files);
  try {
    const plan = detectCoverage(dir);
    assert.deepEqual(plan.steps[0][1], ["test", "--coverage", "--coverage-reporter=lcov"]);
    assert.match(plan.warn, /too large to enumerate/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bunScriptTestFiles: flags/filters skipped, value-flags don't leak their value as a test file", () => {
  const { files, keepFlags } = bunScriptTestFiles({
    scripts: {
      test: "bun test",
      "test:unit": "bun test --timeout 5000 --preload ./setup.ts ./x.itest.ts unitfilter",
      lint: "eslint .",
      "test:svc": "vitest run ./z.itest.js"
    }
  });
  assert.deepEqual(files, ["x.itest.ts"], "flag values, bare filters and non-bun runners all skipped");
  assert.deepEqual(keepFlags, ["--preload=./setup.ts"], "preload survives as a kept flag, not a test file");
});

test("bunScriptTestFiles: -r/--preload= forms canonicalize; env-file kept; timeout value dropped", () => {
  const { files, keepFlags } = bunScriptTestFiles({
    scripts: { "test:unit": "bun test -r ./happydom.ts --env-file=.env.test --timeout=5000 ./a.itest.js" }
  });
  assert.deepEqual(files, ["a.itest.js"]);
  assert.deepEqual(keepFlags, ["--preload=./happydom.ts", "--env-file=.env.test"]);
});

test("bunScriptTestFiles: every `bun test` segment of a &&-chain is harvested", () => {
  const { files } = bunScriptTestFiles({
    scripts: { "test:all": "bun test ./a.itest.js && bun test ./b.itest.js; bun test ./c.itest.js" }
  });
  assert.deepEqual(files, ["a.itest.js", "b.itest.js", "c.itest.js"]);
});

test("bunScriptTestFiles: `test` must be bun's subcommand — 'bun build ./src/test.ts' harvests nothing", () => {
  const { files } = bunScriptTestFiles({
    scripts: { "test:build": "bun build ./src/test.ts --outdir dist", "test:gen": "bun run scripts/test.ts" }
  });
  assert.deepEqual(files, []);
});

test("bunScriptTestFiles: name exclusion matches whole segments — test:upload harvested, test:load skipped", () => {
  const { files } = bunScriptTestFiles({
    scripts: {
      "test:upload": "bun test ./src/upload.itest.ts",
      "test:payload": "bun test ./src/payload.itest.ts",
      "test:performance-utils": "bun test ./src/perfutils.itest.ts",
      "test:load": "bun test ./src/load.itest.ts",
      "test:perf": "bun test ./src/perf.itest.ts",
      "test:e2e-suite": "bun test ./src/suite.itest.ts"
    }
  });
  assert.deepEqual(files, ["src/upload.itest.ts", "src/payload.itest.ts", "src/perfutils.itest.ts"], "'load'/'perf'/'e2e' only exclude as whole name segments");
});

test("bunScriptTestFiles: e2e/integration PATHS are excluded even in plainly-named scripts, incl. no ./ prefix", () => {
  const { files } = bunScriptTestFiles({
    scripts: { "test:svc": "bun test e2e/checkout.itest.js src/e2e/deep.itest.js ./src/checkout.e2e.ts src/a.itest.js" }
  });
  assert.deepEqual(files, ["src/a.itest.js"]);
});

test("bunScriptTestFiles: quoted paths with spaces survive tokenization", () => {
  const { files } = bunScriptTestFiles({
    scripts: { "test:q": `bun test "./src/my file.itest.js" ./b.itest.js` }
  });
  assert.deepEqual(files, ["src/my file.itest.js", "b.itest.js"]);
});
