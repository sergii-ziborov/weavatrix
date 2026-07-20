import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCargoDependencyEvidence } from "../src/analysis/cargo-dependency-evidence.js";

test("cargo evidence: self-crate references are resolved, genuinely undeclared crates stay missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-cargo-"));
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "beacontrail"\n\n[dependencies]\nanyhow = "1"\n`);
  try {
    const externalImports = [
      // `use beacontrail::wlan;` in an example / the paired [[bin]] — the crate referencing itself.
      { ecosystem: "crates.io", pkg: "beacontrail", file: "examples/probe.rs", spec: "beacontrail::wlan", line: 1 },
      { ecosystem: "crates.io", pkg: "anyhow", file: "src/lib.rs", spec: "anyhow::Result", line: 2 },
      // A real crate that is imported but not declared must still surface.
      { ecosystem: "crates.io", pkg: "trex-stl-lib", file: "src/probe.rs", spec: "trex_stl_lib::api", line: 3 },
    ];
    const ev = collectCargoDependencyEvidence(dir, { files: ["Cargo.toml"], externalImports });
    const missing = ev.findings.filter((f) => f.rule === "missing-dep").map((f) => f.package);
    assert.ok(!missing.includes("beacontrail"), "a crate referencing its own package is not a missing dependency");
    assert.ok(!missing.includes("anyhow"), "a declared crate is not missing");
    assert.deepEqual(missing, ["trex-stl-lib"], "only the genuinely undeclared crate is reported missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
