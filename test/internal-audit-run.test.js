import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInternalAudit } from "../src/analysis/internal-audit.js";

test("internal audit reports NOT_CHECKED states and honors managed Python runtime config", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-run-"));
  try {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "runtime.py"), "import numpy\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { runtime: "python scripts/runtime.py" } }));
    writeFileSync(join(repo, ".weavatrix-deps.json"), JSON.stringify({ python: { managedDependencies: ["numpy"] } }));
    const graph = {
      nodes: [{ id: "scripts/runtime.py", source_file: "scripts/runtime.py", file_type: "code" }],
      links: [],
      externalImports: [{ file: "scripts/runtime.py", spec: "numpy", pkg: "numpy", ecosystem: "PyPI", kind: "py-import", line: 1 }],
    };
    const audit = await runInternalAudit(repo, { graph, advisoryStorePath: join(repo, "missing-advisories.json"), skipMalwareScan: true });
    assert.equal(audit.ok, true);
    assert.equal(audit.checks.osv.status, "NOT_CHECKED");
    assert.equal(audit.checks.malware.status, "NOT_CHECKED");
    assert.equal(audit.scanned.managedPythonDependencies, 1);
    assert.ok(!audit.findings.some((f) => f.rule === "missing-dep" && f.package === "numpy"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("internal audit preserves PARTIAL OSV coverage and distrusts a legacy global-only stamp", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-osv-state-"));
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
    const graph = { nodes: [], links: [], externalImports: [] };
    const partialPath = join(repo, "partial.json");
    const now = new Date().toISOString();
    writeFileSync(partialPath, JSON.stringify({
      meta: { fetched_at: now, repos: { [repo]: { fetched_at: now, status: "PARTIAL", queried: 4, queried_ok: 3, error_count: 1 } } },
      records: {},
    }));
    const partial = await runInternalAudit(repo, { graph, advisoryStorePath: partialPath, skipMalwareScan: true });
    assert.equal(partial.checks.osv.status, "PARTIAL");
    assert.match(partial.checks.osv.detail, /3\/4/);

    const staleOkPath = join(repo, "stale-ok.json");
    writeFileSync(staleOkPath, JSON.stringify({
      meta: { fetched_at: now, repos: { [repo]: { fetched_at: now, status: "OK", queried: 0, queried_ok: 0, query_fingerprint: "stale" } } },
      records: {},
    }));
    const staleOk = await runInternalAudit(repo, { graph, advisoryStorePath: staleOkPath, skipMalwareScan: true });
    assert.equal(staleOk.checks.osv.status, "PARTIAL");
    assert.match(staleOk.checks.osv.detail, /Dependency versions changed/);

    const legacyPath = join(repo, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify({ meta: { fetched_at: now }, records: {} }));
    const legacy = await runInternalAudit(repo, { graph, advisoryStorePath: legacyPath, skipMalwareScan: true });
    assert.equal(legacy.checks.osv.status, "NOT_CHECKED");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
