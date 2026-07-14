// reinstall — package-manager detection from a repo's lockfiles/manifests (the reinstall PLAN; the
// actual shell-out is not exercised here). One repo can yield several plans (JS + Python + Go).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectReinstallPlans } from "../src/tools/reinstall.js";

const roots = [];
const mkRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "rl-reinstall-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
};
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const one = (plans, manager) => plans.find((p) => p.manager === manager);

test("npm: package-lock.json → npm ci (clean install)", () => {
  const plans = detectReinstallPlans(mkRepo({ "package.json": "{}", "package-lock.json": "{}" }));
  assert.deepEqual(one(plans, "npm").args, ["ci"]);
  assert.equal(one(plans, "npm").run, true);
});

test("pnpm / yarn / bun win over a bare package.json by their lockfile", () => {
  assert.equal(one(detectReinstallPlans(mkRepo({ "package.json": "{}", "pnpm-lock.yaml": "" })), "pnpm").cmd, "pnpm");
  assert.equal(one(detectReinstallPlans(mkRepo({ "package.json": "{}", "yarn.lock": "" })), "yarn").cmd, "yarn");
  assert.equal(one(detectReinstallPlans(mkRepo({ "package.json": "{}", "bun.lockb": "" })), "bun").cmd, "bun");
});

test("npm: package.json with no lockfile → npm install", () => {
  assert.deepEqual(one(detectReinstallPlans(mkRepo({ "package.json": "{}" })), "npm").args, ["install"]);
});

test("python: uv / poetry / pipenv detected by their lock/manifest", () => {
  assert.equal(one(detectReinstallPlans(mkRepo({ "uv.lock": "" })), "uv").cmd, "uv");
  assert.equal(one(detectReinstallPlans(mkRepo({ "poetry.lock": "" })), "poetry").cmd, "poetry");
  assert.equal(one(detectReinstallPlans(mkRepo({ "pyproject.toml": "[tool.poetry]\nname='x'" })), "poetry").why.includes("poetry") , true);
  assert.equal(one(detectReinstallPlans(mkRepo({ "Pipfile": "" })), "pipenv").cmd, "pipenv");
});

test("python pip: run:false without a venv (never touch the global interpreter); venv pip → run:true", () => {
  const noVenv = one(detectReinstallPlans(mkRepo({ "requirements.txt": "requests==2.31.0" })), "pip");
  assert.equal(noVenv.run, false);
  assert.equal(noVenv.skipCode, "python-no-venv");
  assert.match(noVenv.skip, /global Python/i);

  const withVenv = one(detectReinstallPlans(mkRepo({ "requirements.txt": "requests==2.31.0", "venv/Scripts/pip.exe": "" })), "pip");
  assert.equal(withVenv.run, true);
  assert.match(withVenv.cmd, /pip\.exe$/);
});

test("go: go.mod → go mod download", () => {
  assert.deepEqual(one(detectReinstallPlans(mkRepo({ "go.mod": "module x" })), "go").args, ["mod", "download"]);
});

test("polyglot repo yields one plan per ecosystem", () => {
  const plans = detectReinstallPlans(mkRepo({ "package.json": "{}", "package-lock.json": "{}", "go.mod": "module x", "uv.lock": "" }));
  assert.deepEqual(plans.map((p) => p.ecosystem).sort(), ["Go", "JavaScript", "PyPI"]);
});

test("empty repo → no plans", () => {
  assert.deepEqual(detectReinstallPlans(mkRepo({ "README.md": "hi" })), []);
});
