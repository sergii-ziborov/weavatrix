import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGraphForRepo } from "../src/build-graph.js";
import { graphHomeDir, graphOutDirForModule, graphOutDirForRepo } from "../src/graph/layout.js";
import { repositoryRecord } from "../src/graph/repo-registry.js";

test("a scoped diagnostic build never replaces the canonical repository registry graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-scoped-registry-"));
  const repo = join(root, "repo");
  const previousHome = process.env.WEAVATRIX_GRAPH_HOME;
  process.env.WEAVATRIX_GRAPH_HOME = join(root, "graphs");
  try {
    mkdirSync(join(repo, "src", "feature"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "src", "feature", "index.js"), "export const value = 1;\n");
    const canonical = graphOutDirForRepo(repo);
    const full = await buildGraphForRepo(repo, { mode: "full" });
    assert.equal(full.ok, true);
    assert.equal(realpathSync.native(repositoryRecord(repo, graphHomeDir()).graphDir), realpathSync.native(canonical));

    const scopedDir = graphOutDirForModule(repo, "src/feature");
    const scoped = await buildGraphForRepo(repo, { mode: "full", scope: "src/feature", outDir: scopedDir });
    assert.equal(scoped.ok, true);
    assert.equal(realpathSync.native(repositoryRecord(repo, graphHomeDir()).graphDir), realpathSync.native(canonical));
    assert.notEqual(resolve(scopedDir), resolve(canonical));
  } finally {
    if (previousHome == null) delete process.env.WEAVATRIX_GRAPH_HOME;
    else process.env.WEAVATRIX_GRAPH_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full build never incrementally reuses an incomplete current-schema graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-schema-rebuild-"));
  const repo = join(root, "repo");
  const outDir = join(root, "graph-output");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "index.js"), "export const value = 1;\n");
    const first = await buildGraphForRepo(repo, { mode: "full", precision: "off", outDir });
    assert.equal(first.ok, true, first.error);
    const graphPath = join(outDir, "graph.json");
    const stale = JSON.parse(readFileSync(graphPath, "utf8"));
    stale.extImportsV = 1;
    writeFileSync(graphPath, JSON.stringify(stale));

    const rebuilt = await buildGraphForRepo(repo, { mode: "full", precision: "off", outDir });
    assert.equal(rebuilt.ok, true, rebuilt.error);
    assert.equal(rebuilt.refresh.kind, "full");
    assert.equal(JSON.parse(readFileSync(graphPath, "utf8")).extImportsV, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
