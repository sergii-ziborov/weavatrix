import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCargoDependencyEvidence } from "../src/analysis/cargo-dependency-evidence.js";
import { parseCargoToml } from "../src/analysis/cargo-manifests.js";

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

test("cargo manifest: array-of-tables sections keep the package name and never leak phantom name/path deps", () => {
  // [[bin]] renamed to `beacon` sits between [package] and [dependencies]; [[example]] after them.
  const parsed = parseCargoToml(`[package]
name = "beacon-mcp"

[[bin]]
name = "beacon"
path = "src/main.rs"

[dependencies]
serde = "1"

[[example]]
name = "demo"
path = "examples/demo.rs"
`);
  assert.equal(parsed.packageName, "beacon-mcp", "a [[bin]] name = must not overwrite the package name");
  assert.deepEqual(parsed.dependencies.map((d) => d.alias).sort(), ["serde"], "only real dependencies are parsed — [[bin]]/[[example]] name/path are not phantom deps");
});

test("cargo evidence: a [[bin]] renamed to a dependency crate is not a false self-reference or unused dep", () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-cargo-bin-"));
  // package `beacon-mcp` ships a [[bin]] renamed to `beacon`, which is ALSO a real dependency it uses.
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "beacon-mcp"\n\n[[bin]]\nname = "beacon"\npath = "src/main.rs"\n\n[dependencies]\nbeacon = "1"\nanyhow = "1"\n`);
  try {
    const externalImports = [
      { ecosystem: "crates.io", pkg: "beacon", file: "src/main.rs", spec: "beacon::wlan", line: 1 },
      { ecosystem: "crates.io", pkg: "anyhow", file: "src/main.rs", spec: "anyhow::Result", line: 2 },
    ];
    const ev = collectCargoDependencyEvidence(dir, { files: ["Cargo.toml"], externalImports });
    const unused = ev.findings.filter((f) => f.rule === "unused-dep").map((f) => f.package);
    const missing = ev.findings.filter((f) => f.rule === "missing-dep").map((f) => f.package);
    assert.ok(!unused.includes("beacon"), "beacon is used via beacon:: imports; the [[bin]] rename must not read them as self-references");
    assert.deepEqual(unused, [], "no dependency is unused");
    assert.deepEqual(missing, [], "no dependency is missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
