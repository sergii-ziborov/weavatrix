import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/process.js";
import { searchAcrossRepos } from "../src/scan/search.js";

const base = mkdtempSync(join(tmpdir(), "rl-search-"));
after(() => rmSync(base, { recursive: true, force: true }));

mkdirSync(join(base, "src", "nested"), { recursive: true });
mkdirSync(join(base, "node_modules", "ignored"), { recursive: true });
writeFileSync(join(base, "src", "nested", "target-file.js"), "first needle\nnope\nsecond needle\nthird needle\n");
writeFileSync(join(base, "node_modules", "ignored", "target-file.js"), "needle from dependency\n");

test("node search: content mode returns multiple hits per file, still skipping dependency dirs", async () => {
  const r = await searchAcrossRepos({ repos: [base], query: "needle", mode: "content", cap: 10, engine: "node" });
  assert.equal(r.ok, true);
  assert.equal(r.engine, "node-fallback");
  assert.deepEqual(r.results.map((x) => x.line), [1, 3, 4]);
  assert.ok(r.results.every((x) => !x.path.includes("node_modules")));
});

test("node search: filename mode matches relative paths, not only basenames", async () => {
  const r = await searchAcrossRepos({ repos: [base], query: "nested/target", mode: "filename", cap: 10, engine: "node" });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.match(r.results[0].preview, /src\/nested\/target-file\.js$/);
});

test("git search: content mode is fast and still includes untracked files", async (t) => {
  try {
    await runCommand("git", ["--version"], { timeoutMs: 5000 });
  } catch {
    t.skip("git is not available");
    return;
  }
  const gitRepo = mkdtempSync(join(tmpdir(), "rl-search-git-"));
  t.after(() => rmSync(gitRepo, { recursive: true, force: true }));
  mkdirSync(join(gitRepo, "src"), { recursive: true });
  writeFileSync(join(gitRepo, "src", "tracked.js"), "tracked needle\n");
  writeFileSync(join(gitRepo, "src", "untracked.js"), "untracked needle\n");
  assert.equal((await runCommand("git", ["init"], { cwd: gitRepo, timeoutMs: 5000 })).exitCode, 0);
  assert.equal((await runCommand("git", ["add", "src/tracked.js"], { cwd: gitRepo, timeoutMs: 5000 })).exitCode, 0);

  const r = await searchAcrossRepos({ repos: [gitRepo], query: "needle", mode: "content", cap: 10, engine: "git" });
  assert.equal(r.ok, true);
  assert.equal(r.engine, "git-grep");
  assert.deepEqual(r.results.map((x) => x.preview).sort(), ["tracked needle", "untracked needle"]);
});

test("git search: filename mode matches repo-relative paths", async (t) => {
  try {
    await runCommand("git", ["--version"], { timeoutMs: 5000 });
  } catch {
    t.skip("git is not available");
    return;
  }
  const gitRepo = mkdtempSync(join(tmpdir(), "rl-search-git-name-"));
  t.after(() => rmSync(gitRepo, { recursive: true, force: true }));
  mkdirSync(join(gitRepo, "src", "nested"), { recursive: true });
  writeFileSync(join(gitRepo, "src", "nested", "target-file.js"), "x\n");
  assert.equal((await runCommand("git", ["init"], { cwd: gitRepo, timeoutMs: 5000 })).exitCode, 0);

  const r = await searchAcrossRepos({ repos: [gitRepo], query: "nested/target", mode: "filename", cap: 10, engine: "git" });
  assert.equal(r.ok, true);
  assert.equal(r.engine, "git-grep");
  assert.equal(r.results.length, 1);
  assert.match(r.results[0].preview, /src\/nested\/target-file\.js$/);
});
