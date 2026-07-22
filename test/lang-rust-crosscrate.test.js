import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalGraph } from "../src/graph/internal-builder.js";
import { collectCargoDependencyEvidence } from "../src/analysis/cargo-dependency-evidence.js";

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "wx-rsx-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const WORKSPACE = {
  "Cargo.toml": `[workspace]\nmembers = ["crates/beacon", "crates/beacon-mcp"]\n`,
  "crates/beacon/Cargo.toml": `[package]\nname = "beacon"\n\n[dependencies]\n`,
  "crates/beacon/src/lib.rs": `pub mod wlan;\npub mod events;\n`,
  "crates/beacon/src/wlan.rs": `pub fn wifi_status() -> u32 { 1 }\n`,
  "crates/beacon/src/events.rs": `pub fn recent() -> u32 { 2 }\n`,
  // beacon-mcp's [[bin]] is renamed to `beacon`, which is also its path dependency.
  "crates/beacon-mcp/Cargo.toml": `[package]\nname = "beacon-mcp"\n\n[[bin]]\nname = "beacon"\npath = "src/main.rs"\n\n[dependencies]\nbeacon = { path = "../beacon" }\n`,
  "crates/beacon-mcp/src/main.rs": `use beacon::wlan;
use beacon::events::recent as fetch_recent;
use std::fs::OpenOptions;

pub struct Detector;

impl Detector {
    pub fn new() -> Self { Detector }
    pub fn run(&self) -> u32 {
        let _f = OpenOptions::new();
        let mut v: Vec<u32> = Vec::new();
        v.push(wlan::wifi_status());
        v.push(fetch_recent());
        v.push(beacon::events::recent());
        let d = Detector::new();
        d.inner() + v.len() as u32
    }
    pub fn inner(&self) -> u32 { 0 }
}

fn main() {}
`,
};

test("lang-rust: cross-crate calls resolve into sibling workspace crates", async () => {
  const dir = repoWith(WORKSPACE);
  try {
    const g = await buildInternalGraph(dir);
    const ep = (v) => String(v && typeof v === "object" ? v.id : v);
    const calls = g.links.filter((l) => l.relation === "calls");
    const has = (source, target) => calls.some((l) => ep(l.source).includes(source) && ep(l.target).includes(target));

    assert.ok(has("beacon-mcp/src/main.rs#run", "beacon/src/wlan.rs#wifi_status"), "a use-bound sibling-crate module call (wlan::wifi_status) resolves across crates");
    assert.ok(has("beacon-mcp/src/main.rs#run", "beacon/src/events.rs#recent"), "a fully-qualified sibling-crate call (beacon::events::recent) resolves across crates");

    const imports = g.links.filter((l) => l.relation === "imports");
    assert.ok(
      imports.some((l) => ep(l.source).includes("beacon-mcp/src/main.rs") && ep(l.target).includes("beacon/src/wlan.rs") && l.compileOnly === true),
      "a cross-crate `use` is a compile-only import edge, not a runtime one",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lang-rust: external Type::method() never mis-binds to a same-named local function", async () => {
  const dir = repoWith(WORKSPACE);
  try {
    const g = await buildInternalGraph(dir);
    const ep = (v) => String(v && typeof v === "object" ? v.id : v);
    const calls = g.links.filter((l) => l.relation === "calls");
    // Detector::new is the only local `new`; OpenOptions::new() and Vec::new() are external.
    const runToNew = calls.filter((l) => ep(l.source).includes("main.rs#run") && /main\.rs#new@/.test(ep(l.target)));
    assert.equal(runToNew.length, 1, "only the local Detector::new binds; external OpenOptions::new / Vec::new produce no edge");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lang-rust: a resolved sibling path crate is still counted as a used Cargo dependency", async () => {
  const dir = repoWith(WORKSPACE);
  try {
    const g = await buildInternalGraph(dir);
    const cargo = collectCargoDependencyEvidence(dir, { externalImports: g.externalImports });
    assert.ok(
      !cargo.findings.some((f) => f.rule === "unused-dep" && f.package === "beacon"),
      "resolving beacon into its crate must not drop the dependency-usage signal that keeps it out of unused-dep",
    );
    assert.ok(g.externalImports.some((e) => e.pkg === "beacon"), "the sibling crate stays recorded as a dependency import");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
