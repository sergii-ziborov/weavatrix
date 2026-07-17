import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInternalGraph } from "../src/graph/internal-builder.js";
import { filterGraphForMode } from "../src/graph/graph-filter.js";
import { loadGraph } from "../src/mcp/graph-context.mjs";
import { tRunAudit } from "../src/mcp/tools-health.mjs";

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

test("run_audit compares an immutable baseline and never relabels old debt as new", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "weavatrix-audit-debt-"));
  const repo = join(fixtureRoot, "repo");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "audit-debt-fixture",
      type: "module",
      dependencies: { "left-pad": "1.3.0", lodash: "4.17.21" },
    }, null, 2));
    writeFileSync(join(repo, "src", "index.js"), "import { a } from './a.js';\nconsole.log(a);\n");
    writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "fixture@example.test");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "baseline");

    // Keep the old unused dependency, but also touch its manifest so it is inside the changed scope.
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "audit-debt-fixture",
      type: "module",
      scripts: { check: "node src/index.js" },
      dependencies: { "left-pad": "1.3.0" },
    }, null, 2));
    writeFileSync(join(repo, "src", "a.js"), [
      "import { b } from './b.js';",
      "import chalk from 'chalk';",
      "export const a = b + String(chalk).length;",
      "export const unusedNow = 42;",
      "",
    ].join("\n"));
    writeFileSync(join(repo, "src", "b.js"), "import { a } from './a.js';\nexport const b = a ? 1 : 0;\n");

    const graph = await buildInternalGraph(repo);
    const graphPath = join(fixtureRoot, "graph.json");
    writeFileSync(graphPath, JSON.stringify(graph));
    const loaded = loadGraph(graphPath);
    const ctx = { repoRoot: repo, graphPath };

    const compared = await tRunAudit(loaded, { base_ref: "HEAD", max_findings: 100 }, ctx);
    assert.equal(compared.__weavatrixToolResult, true);
    assert.equal(compared.result.status, "COMPLETE");
    assert.equal(compared.result.mode, "baseline-comparison");
    assert.equal(compared.result.debt, "new", "baseline mode defaults to genuinely new debt");
    assert.deepEqual(compared.result.scope.files, ["package.json", "src/a.js", "src/b.js"]);
    const newRules = new Set(compared.result.comparison.new.map((finding) => finding.rule));
    assert.ok(newRules.has("circular-dep"), "a newly introduced runtime cycle is new debt");
    assert.ok(newRules.has("missing-dep"), "a newly imported undeclared package is new debt");
    assert.ok(compared.result.comparison.new.some((finding) => finding.rule === "unused-export" && finding.symbol.includes("unusedNow")), "a newly unused export is new debt");
    assert.ok(!compared.result.comparison.new.some((finding) => finding.package === "left-pad"), "old dependency debt must not be relabelled new");
    assert.ok(compared.result.comparison.existing.some((finding) => finding.rule === "unused-dep" && finding.package === "left-pad"), "old dependency debt remains existing even though package.json changed");
    assert.ok(compared.result.comparison.fixed.some((finding) => finding.rule === "unused-dep" && finding.package === "lodash"), "removed baseline debt is reported as fixed");
    assert.ok(compared.result.findings.every((finding) => compared.result.comparison.new.some((fresh) => fresh.id === finding.id)), "default output contains new findings only");
    assert.ok(compared.result.comparison.optional.checks.every((check) => check.status === "UNCOMPARABLE"));
    assert.match(compared.text, /OSV UNCOMPARABLE/);
    assert.match(compared.text, /fixed deterministic finding/);

    const scoped = await tRunAudit(loaded, { changed_files: ["src/a.js"], max_findings: 100 }, ctx);
    assert.equal(scoped.__weavatrixToolResult, true);
    assert.equal(scoped.result.mode, "changed-scope");
    assert.equal(scoped.result.comparison.status, "UNAVAILABLE");
    assert.match(scoped.text, /^CHANGED-SCOPE ONLY/);
    assert.match(scoped.text, /not classified as new, existing, or fixed/);
    assert.ok(scoped.result.findings.length > 0);
    assert.ok(scoped.result.findings.every((finding) => !Object.hasOwn(finding, "debtState")), "changed-scope findings receive no invented debt state");

    const ordinary = await tRunAudit(loaded, {}, ctx);
    assert.equal(typeof ordinary, "string", "run_audit with no new arguments preserves the legacy response contract");
    assert.match(ordinary, /^Internal audit of /);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("derived Git scope keeps new manifest debt caused by removing its only importer", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "weavatrix-audit-causal-scope-"));
  const repo = join(fixtureRoot, "repo");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "causal-scope-fixture",
      type: "module",
      dependencies: { "left-pad": "1.3.0" },
    }, null, 2));
    writeFileSync(join(repo, "src", "index.js"), "import leftPad from 'left-pad';\nconsole.log(leftPad('x', 2));\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "fixture@example.test");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "baseline");

    writeFileSync(join(repo, "src", "index.js"), "console.log('dependency removed from source');\n");
    const graph = await buildInternalGraph(repo);
    const graphPath = join(fixtureRoot, "graph.json");
    writeFileSync(graphPath, JSON.stringify(graph));
    const compared = await tRunAudit(loadGraph(graphPath), { base_ref: "HEAD", max_findings: 100 }, { repoRoot: repo, graphPath });

    assert.deepEqual(compared.result.scope.files, ["src/index.js"]);
    assert.ok(compared.result.comparison.new.some((finding) =>
      finding.rule === "unused-dep" && finding.package === "left-pad" && finding.manifest === "package.json"));
    assert.ok(compared.result.findings.some((finding) => finding.package === "left-pad"), "default new-debt output must not hide causal manifest debt");
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});

test("no-tests audit compares against a no-tests Git baseline", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "weavatrix-audit-no-tests-"));
  const repo = join(fixtureRoot, "repo");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "audit-no-tests-fixture",
      type: "module",
    }, null, 2));
    writeFileSync(join(repo, "src", "index.js"), "export const live = 1;\n");
    writeFileSync(join(repo, "test", "orphan.test.js"), "export function testOnlyOrphan() { return 1; }\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "fixture@example.test");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "baseline");

    const full = await buildInternalGraph(repo);
    const graph = filterGraphForMode(full, "no-tests", { repoRoot: repo });
    graph.graphBuildMode = "no-tests";
    graph.graphBuildScope = "";
    const graphPath = join(fixtureRoot, "graph.json");
    writeFileSync(graphPath, JSON.stringify(graph));

    const compared = await tRunAudit(loadGraph(graphPath), { base_ref: "HEAD", debt: "all", max_findings: 100 }, { repoRoot: repo, graphPath });
    assert.equal(compared.result.status, "COMPLETE");
    assert.equal(compared.result.comparison.totals.repository.new, 0);
    assert.equal(compared.result.comparison.totals.repository.fixed, 0,
      "test-only findings must not appear as fixed when both sides use no-tests");
    assert.ok(compared.result.findings.every((finding) => !String(finding.file || finding.source_file || "").startsWith("test/")));
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});
