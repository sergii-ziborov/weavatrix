// Manifest parsers for the non-npm ecosystems (analysis/manifests.js): go.mod requires/replaces,
// PEP 508 requirement lines, pyproject (PEP 621 + poetry + build-system), Pipfile tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoMod, requirementName, parseRequirementsNames, parsePyprojectDeps, parsePipfileDeps } from "../src/analysis/manifests.js";

test("parseGoMod: module, require block + single-line, indirect flag, replace", () => {
  const gm = parseGoMod(`module github.com/acme/speaker

go 1.22

require (
\tgithub.com/segmentio/kafka-go v0.4.47
\tgolang.org/x/sys v0.15.0 // indirect
)

require gopkg.in/yaml.v3 v3.0.1

replace github.com/old/mod => ../local-mod
`);
  assert.equal(gm.module, "github.com/acme/speaker");
  assert.deepEqual(gm.requires.map((r) => [r.path, r.indirect]), [
    ["github.com/segmentio/kafka-go", false],
    ["golang.org/x/sys", true],
    ["gopkg.in/yaml.v3", false],
  ]);
  assert.equal(gm.requires[0].version, "v0.4.47");
  assert.deepEqual(gm.replaces, [{ from: "github.com/old/mod", to: "../local-mod" }]);
});

test("requirementName: PEP 508 heads; options/URLs/paths skipped; #egg= kept", () => {
  assert.equal(requirementName("requests>=2.28,<3"), "requests");
  assert.equal(requirementName("uvicorn[standard]==0.23.2 ; python_version >= '3.8'"), "uvicorn");
  assert.equal(requirementName("  # comment only"), null);
  assert.equal(requirementName("-r base.txt"), null);
  assert.equal(requirementName("--hash=sha256:deadbeef"), null);
  assert.equal(requirementName("./local/pkg"), null);
  assert.equal(requirementName("git+https://github.com/x/y.git#egg=y-pkg"), "y-pkg");
  assert.equal(requirementName("https://files.pythonhosted.org/x.whl"), null);
});

test("parseRequirementsNames: dedupes by canonical name", () => {
  const names = parseRequirementsNames("Flask==2.3\nflask\nPyYAML>=6\n");
  assert.deepEqual(names.map((d) => d.name), ["Flask", "PyYAML"]);
});

test("parsePyprojectDeps: PEP 621 arrays (inline + multi-line), optional deps, build-system", () => {
  const r = parsePyprojectDeps(`[build-system]
requires = ["hatchling"]

[project]
name = "svc"
dependencies = [
  "requests>=2.28",
  "pydantic[email]==2.5",
]

[project.optional-dependencies]
dev = ["pytest>=7", "ruff"]
`);
  assert.equal(r.present, true);
  const byName = Object.fromEntries(r.deps.map((d) => [d.name, d]));
  assert.equal(byName.requests.dev, false);
  assert.equal(byName.pydantic.dev, false);
  assert.equal(byName.pytest.dev, true);
  assert.equal(byName.hatchling.buildSystem, true);
});

test("parsePyprojectDeps: [extras] on the array's FIRST line must not close the array", () => {
  const r = parsePyprojectDeps(`[project]
dependencies = ["requests[security]>=2.0",
    "flask>=2.0",
    "click"]
`);
  assert.deepEqual(r.deps.map((d) => d.name), ["requests", "flask", "click"]);
});

test("parsePyprojectDeps: poetry tables incl. groups; python pseudo-dep skipped", () => {
  const r = parsePyprojectDeps(`[tool.poetry.dependencies]
python = "^3.11"
httpx = { version = "^0.25", extras = ["http2"] }

[tool.poetry.group.dev.dependencies]
pytest = "^7.4"
`);
  assert.equal(r.present, true);
  assert.deepEqual(r.deps.map((d) => [d.name, d.dev]), [["httpx", false], ["pytest", true]]);
});

test("parsePipfileDeps: packages vs dev-packages", () => {
  const r = parsePipfileDeps(`[[source]]
url = "https://pypi.org/simple"

[packages]
requests = "*"
"discord.py" = ">=2"

[dev-packages]
black = "*"
`);
  assert.equal(r.present, true);
  assert.deepEqual(r.deps.map((d) => [d.name, d.dev]), [["requests", false], ["discord.py", false], ["black", true]]);
});
