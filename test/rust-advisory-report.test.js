import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRustAdvisoryReport } from "../src/security/rust-advisory-report.js";

test("saved cargo-audit JSON adds RustSec vulnerability and warning evidence without running Cargo", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-rustsec-"));
  try {
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".weavatrix"));
    writeFileSync(join(repo, ".weavatrix", "cargo-audit.json"), JSON.stringify({
      database: { "last-updated": "2026-07-18T00:00:00Z" },
      vulnerabilities: { list: [{ advisory: { id: "RUSTSEC-2026-0001", title: "unsafe crate", url: "https://rustsec.org/advisories/RUSTSEC-2026-0001" }, package: { name: "demo", version: "1.0.0" }, versions: { patched: [">=1.0.1"] } }] },
      warnings: { unmaintained: [{ advisory: { id: "RUSTSEC-2026-0002", title: "unmaintained" }, package: { name: "old", version: "0.1.0" } }] },
    }));
    const result = loadRustAdvisoryReport(repo, { now: Date.parse("2026-07-19T00:00:00Z") });
    assert.equal(result.status, "OK");
    assert.deepEqual(result.findings.map((item) => [item.kind, item.package]), [["vulnerability", "demo"], ["unmaintained", "old"]]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("missing or stale cargo-audit reports cannot produce a clean result", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-rustsec-state-"));
  try {
    mkdirSync(join(repo, ".git"));
    assert.equal(loadRustAdvisoryReport(repo).status, "NOT_CHECKED");
    writeFileSync(join(repo, "cargo-audit.json"), JSON.stringify({ database: { "last-updated": "2020-01-01T00:00:00Z" }, vulnerabilities: { list: [] } }));
    assert.equal(loadRustAdvisoryReport(repo, { now: Date.parse("2026-07-19T00:00:00Z") }).status, "PARTIAL");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
