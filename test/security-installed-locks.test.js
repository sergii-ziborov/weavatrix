// Python lockfile parsers added for supply-chain coverage beyond requirements.txt ==pins:
// poetry.lock / uv.lock ([[package]] TOML blocks) and Pipfile.lock (JSON default/develop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstalled, parseTomlLockPackages, parsePipfileLock, parseGoModPackages } from "../src/security/installed.js";

test("parseTomlLockPackages: poetry/uv [[package]] blocks → PyPI entries; other tables ignored", () => {
  const out = parseTomlLockPackages(`[[package]]
name = "Requests"
version = "2.31.0"
description = "HTTP for Humans"

[package.dependencies]
certifi = ">=2017"

[[package]]
name = "py-yaml-shim"
version = "1.0"

[metadata]
lock-version = "2.0"
`, "poetry-lock");
  assert.deepEqual(out.map((p) => [p.ecosystem, p.name, p.version, p.source]), [
    ["PyPI", "requests", "2.31.0", "poetry-lock"],
    ["PyPI", "py-yaml-shim", "1.0", "poetry-lock"],
  ]);
});

test("parsePipfileLock: default + develop sections, == stripped", () => {
  const out = parsePipfileLock({
    _meta: {},
    default: { requests: { version: "==2.31.0" } },
    develop: { black: { version: "==24.1.0" } },
  });
  assert.deepEqual(out.map((p) => [p.name, p.version, p.dev]), [
    ["requests", "2.31.0", false],
    ["black", "24.1.0", true],
  ]);
  assert.deepEqual(parsePipfileLock(null), []);
});

test("parseGoModPackages: require versions become Go entries (v stripped, indirect→dev); go.mod fallback for no-go.sum repos", () => {
  const out = parseGoModPackages(`module weavatrix.com/gpro/aggregator

go 1.26.4

require (
	github.com/namsral/flag v1.7.4-pre
	golang.org/x/net v0.17.0 // indirect
)

require github.com/gin-gonic/gin v1.9.1
`);
  assert.deepEqual(out.map((p) => [p.ecosystem, p.name, p.version, p.dev]).sort(), [
    ["Go", "github.com/gin-gonic/gin", "1.9.1", false],
    ["Go", "github.com/namsral/flag", "1.7.4-pre", false],
    ["Go", "golang.org/x/net", "0.17.0", true], // // indirect → dev
  ].sort());
  assert.deepEqual(parseGoModPackages(""), []);
});

test("collectInstalled: immediate npm and Python subprojects are included for monorepos", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-installed-monorepo-"));
  try {
    mkdirSync(join(root, "api"), { recursive: true });
    mkdirSync(join(root, "ui"), { recursive: true });
    writeFileSync(join(root, "api", "requirements.txt"), "Requests==2.31.0\n");
    writeFileSync(join(root, "ui", "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "ui", version: "1.0.0" },
        "node_modules/lodash": { version: "4.17.21" },
      },
    }));
    const names = collectInstalled(root).installed.map((p) => `${p.ecosystem}:${p.name}@${p.version}`).sort();
    assert.deepEqual(names, ["PyPI:requests@2.31.0", "npm:lodash@4.17.21"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
