import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSourceTexts } from "../src/analysis/internal-audit.js";
import { collectConfigTexts, collectPyManifest, workspacePkgNames } from "../src/analysis/internal-audit.collect.js";
import { collectInstalled } from "../src/security/installed.js";
import { computeDuplicates } from "../src/analysis/duplicates.compute.js";
import { aggregateGraph } from "../src/graph/layout.js";
import { detectEndpoints } from "../src/analysis/endpoints.js";
import { readCoverageForRepo } from "../src/analysis/coverage-reports.js";

function poisonedFixture() {
  const parent = mkdtempSync(join(tmpdir(), "wx-poisoned-graph-"));
  const repo = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  const body = [
    "export function outsideSecret(value) {",
    "  const first = value + 1;",
    "  const second = first * 2;",
    "  const third = second - 3;",
    "  const fourth = third / 4;",
    "  const fifth = fourth + first + second + third;",
    "  const sixth = Math.max(first, second, third, fourth, fifth);",
    "  return { first, second, third, fourth, fifth, sixth };",
    "}",
    "export const route = app.get('/outside-secret', outsideSecret);",
  ].join("\n");
  writeFileSync(join(outside, "a.js"), body);
  writeFileSync(join(outside, "b.js"), body);
  const files = ["../outside/a.js", "../outside/b.js"];
  const graph = {
    nodes: files.flatMap((file, index) => [
      { id: file, label: file, file_type: "code", source_file: file },
      { id: `${file}#outsideSecret${index}@1`, label: `outsideSecret${index}`, file_type: "code", source_file: file, source_location: "L1" },
    ]),
    links: [],
  };
  const graphPath = join(repo, "graph.json");
  writeFileSync(graphPath, JSON.stringify(graph));
  return { parent, repo, graph, graphPath };
}

test("poisoned graph paths are ignored by audit, duplicate, aggregate and endpoint readers", () => {
  const fx = poisonedFixture();
  try {
    const sources = collectSourceTexts(fx.repo, fx.graph);
    assert.ok(!sources.has("../outside/a.js"));

    const duplicates = computeDuplicates(fx.repo, fx.graphPath);
    assert.equal(duplicates.frags.length, 0);

    const aggregate = aggregateGraph(fx.graph, fx.repo);
    assert.ok(aggregate.modules.flatMap((mod) => mod.files).every((file) => file.loc === 0));

    const endpoints = detectEndpoints(fx.repo, ["../outside/a.js"]);
    assert.deepEqual(endpoints, []);
  } finally { rmSync(fx.parent, { recursive: true, force: true }); }
});

test("manifest, config, coverage and installed-package readers reject external directories", () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-repo-read-boundary-"));
  const repo = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  try {
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "outside-workspace", version: "1.0.0" }));
    writeFileSync(join(outside, "requirements.txt"), "outside-secret-package==9.9.9\n");
    writeFileSync(join(outside, "workflow.yml"), "env:\n  OUTSIDE_SECRET: visible\n");
    writeFileSync(join(outside, "coverage-summary.json"), JSON.stringify({
      total: { lines: { total: 1, covered: 1, pct: 100 } },
      "src/a.js": { lines: { total: 1, covered: 1, pct: 100 } },
    }));

    assert.deepEqual([...workspacePkgNames(repo, { workspaces: ["../outside"] })], []);

    mkdirSync(join(repo, ".github"));
    symlinkSync(outside, join(repo, ".github", "workflows"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(outside, join(repo, "requirements"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(outside, join(repo, "coverage"), process.platform === "win32" ? "junction" : "dir");

    assert.equal(collectConfigTexts(repo).size, 0);
    assert.deepEqual(collectPyManifest(repo), { present: false, deps: [] });
    assert.equal(readCoverageForRepo(repo, ["src/a.js"]).size, 0);
    assert.ok(!collectInstalled(repo).installed.some((pkg) => pkg.name === "outside-secret-package"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
