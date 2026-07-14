import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanVersion, detectFramework, detectRepoStack } from "../src/scan/discover.js";

test("cleanVersion: strips range operators, keeps major.minor", () => {
  assert.equal(cleanVersion("^5.2.0"), "5.2");
  assert.equal(cleanVersion("~4.18.2"), "4.18");
  assert.equal(cleanVersion("v1.9.1"), "1.9");
  assert.equal(cleanVersion(">=2.0,<3"), "2.0");
  assert.equal(cleanVersion("==4.2"), "4.2");
  assert.equal(cleanVersion("7"), "7");
  assert.equal(cleanVersion("latest"), "");
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-fw-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("detectFramework(node): Express from package.json deps with version", () => {
  const dir = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.2.0", lodash: "^4" } }) });
  try {
    assert.deepEqual(detectFramework(dir, "node"), { name: "Express", version: "5.2" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectFramework(node): NestJS wins over a generic UI lib (priority order)", () => {
  const dir = fixture({ "package.json": JSON.stringify({ dependencies: { react: "^19", "@nestjs/core": "^10.3.0" } }) });
  try {
    assert.deepEqual(detectFramework(dir, "node"), { name: "NestJS", version: "10.3" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectFramework(go): Echo from go.mod require line", () => {
  const dir = fixture({ "go.mod": "module x\n\ngo 1.22\n\nrequire github.com/labstack/echo/v4 v4.15.0\n" });
  try {
    assert.deepEqual(detectFramework(dir, "go"), { name: "Echo", version: "4.15" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectFramework(python): FastAPI from requirements.txt", () => {
  const dir = fixture({ "requirements.txt": "uvicorn==0.30\nfastapi==0.111.0\n" });
  try {
    assert.deepEqual(detectFramework(dir, "python"), { name: "FastAPI", version: "0.111" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectFramework: no framework → null", () => {
  const dir = fixture({ "package.json": JSON.stringify({ dependencies: { lodash: "^4", "@clickhouse/client": "^1" } }) });
  try {
    assert.equal(detectFramework(dir, "node"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectRepoStack: surfaces languages, runtime, tests and infra badges", () => {
  const dir = fixture({
    "package.json": JSON.stringify({
      dependencies: { mongoose: "^8", ioredis: "^5", "@clickhouse/client": "^1" },
      devDependencies: { typescript: "^5", vitest: "^2", "@playwright/test": "^1" },
      scripts: { test: "vitest", e2e: "playwright test" }
    }),
    "bun.lock": "",
    "tsconfig.json": "{}",
    "src/index.ts": "export const x: number = 1\n",
    "src/legacy.js": "module.exports = {}\n",
    "tests/app.test.ts": "import { test } from 'vitest'\n"
  });
  try {
    const stack = detectRepoStack(dir);
    assert.deepEqual(stack.languages.map((badge) => badge.id), ["typescript", "javascript"]);
    assert.deepEqual(stack.runtimes.map((badge) => badge.id), ["bun"]);
    assert.ok(stack.tests.some((badge) => badge.id === "vitest"));
    assert.ok(stack.tests.some((badge) => badge.id === "playwright"));
    assert.ok(stack.infra.some((badge) => badge.id === "mongodb"));
    assert.ok(stack.infra.some((badge) => badge.id === "redis"));
    assert.ok(stack.infra.some((badge) => badge.id === "clickhouse"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
