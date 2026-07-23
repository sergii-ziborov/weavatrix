import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCoverageForRepo } from "../src/analysis/coverage-reports.js";

test("Rust tarpaulin JSON is mapped onto repo files with line hits", () => {
  const repo = mkdtempSync(join(tmpdir(), "wx-rust-coverage-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "lib.rs"), "pub fn covered() {}\npub fn missed() {}\n");
    writeFileSync(join(repo, "tarpaulin-report.json"), JSON.stringify({
      files: [{
        path: join(repo, "src", "lib.rs").split(/[\\/]+/),
        content: "pub fn covered() {}\npub fn missed() {}\n",
        traces: [
          { line: 1, address: [], length: 1, stats: { Line: 1 } },
          { line: 2, address: [], length: 1, stats: { Line: 0 } },
          { line: "not-a-line", address: [], length: 1, stats: { Line: 1 } },
        ],
        covered: 1,
        coverable: 2,
      }],
      coverage: 50,
      covered: 1,
      coverable: 2,
    }));

    const coverage = readCoverageForRepo(repo, ["src/lib.rs"]);
    const record = coverage.get("src/lib.rs");

    assert.equal(record.source, "tarpaulin-report.json");
    assert.equal(record.total, 2);
    assert.equal(record.covered, 1);
    assert.equal(record.pct, 0.5);
    assert.equal(record.lines.get(1), 1);
    assert.equal(record.lines.get(2), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
