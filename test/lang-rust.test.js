import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalGraph } from "../src/graph/internal-builder.js";

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "wx-rs-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const LIB = `pub trait Greeter {
    fn greet(&self, name: &str) -> String;
}

pub struct Console {
    count: u32,
}

pub const MAX_GREETS: u32 = 10;

impl Greeter for Console {
    fn greet(&self, name: &str) -> String {
        format_msg(name)
    }
}

pub enum Mode { Fast, Slow }

pub mod adapters {
    pub trait Writes { fn write(&self); }
    pub struct Sink;
    impl Writes for Sink { fn write(&self) {} }
}
`;

const HELPER = `pub fn format_msg(name: &str) -> String {
    let mut out = String::from("hi ");
    out.push_str(name);
    out
}
`;

test("lang-rust: symbols and same-folder cross-file calls", async () => {
  const dir = repoWith({ "src/lib.rs": LIB, "src/helper.rs": HELPER });
  try {
    const g = await buildInternalGraph(dir);
    const sym = (name) => g.nodes.find((n) => String(n.id).includes("#" + name + "@"));
    for (const name of ["Greeter", "Console", "Mode", "MAX_GREETS", "greet", "format_msg"]) {
      assert.ok(sym(name), `symbol ${name} extracted`);
    }
    assert.equal(sym("Greeter").symbol_kind, "trait");
    assert.equal(sym("Console").symbol_kind, "struct");
    assert.equal(sym("Mode").symbol_kind, "enum");
    assert.equal(sym("MAX_GREETS").symbol_kind, "constant");
    assert.equal(sym("format_msg").symbol_kind, "function");
    assert.equal(sym("format_msg").exported, true);
    const consoleGreet = g.nodes.find((node) => node.source_file === "src/lib.rs" && node.label === "greet()" && node.member_of === "Console");
    assert.ok(consoleGreet, "impl method retains its owning type");
    assert.equal(consoleGreet.symbol_kind, "method");
    assert.equal(consoleGreet.visibility, "private");
    assert.ok(g.links.some((link) => link.source === sym("Console").id && link.target === consoleGreet.id && link.relation === "method"));
    const ep = (v) => String(v && typeof v === "object" ? v.id : v);
    const call = g.links.find((l) => l.relation === "calls" && ep(l.source).includes("lib.rs#greet") && ep(l.target).includes("helper.rs#format_msg"));
    assert.ok(call, "cross-file call greet -> format_msg via same-folder scope");
    assert.ok(g.links.some((l) => l.relation === "inherits" && ep(l.target).includes("lib.rs#Writes")), "existing Rust trait inheritance extraction remains intact");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lang-rust: resolves outlined modules, use trees, re-exports, and qualified crate paths", async () => {
  const dir = repoWith({
    "src/lib.rs": `
      mod api;
      mod util;
      mod feature { mod nested; }
      #[path = "alt/special.rs"] mod special;
      use crate::api::{Client as ApiClient, types::{Request, Response}};
      use crate::util::run as execute;
      pub use crate::api::types::PublicType;
      use serde::Serialize;
      use std::fmt::Debug;
      pub fn boot() { execute(); crate::util::run(); }
    `,
    "src/api/mod.rs": `
      pub mod types;
      use self::types::Request;
      pub struct Client;
    `,
    "src/api/types.rs": `
      use super::Client;
      pub struct Request;
      pub struct Response;
      pub struct PublicType;
    `,
    "src/util.rs": "pub fn run() {}",
    "src/feature/nested.rs": "pub fn nested() {}",
    "src/alt/special.rs": "pub fn special() {}",
  });
  try {
    const g = await buildInternalGraph(dir);
    const edges = g.links.filter((link) => ["imports", "re_exports"].includes(link.relation));
    const has = (source, target, relation = "imports") => edges.some((link) => link.source === source && link.target === target && link.relation === relation);

    assert.ok(has("src/lib.rs", "src/api/mod.rs"), "lib.rs mod/use tree resolves api/mod.rs");
    assert.ok(has("src/lib.rs", "src/util.rs"), "lib.rs mod and anchored path resolve util.rs");
    assert.ok(has("src/lib.rs", "src/feature/nested.rs"), "outlined module inside an inline module resolves");
    assert.ok(has("src/lib.rs", "src/alt/special.rs"), "top-level #[path] module resolves relative to source file");
    assert.ok(has("src/api/mod.rs", "src/api/types.rs"), "mod.rs owns sibling module files");
    assert.ok(has("src/api/types.rs", "src/api/mod.rs"), "super path resolves the parent module file");
    assert.ok(has("src/lib.rs", "src/api/types.rs", "re_exports"), "pub use is retained as a re-export edge");
    assert.equal(g.edgeTypesV, 2);
    assert.ok(edges.length > 0 && edges.every((link) => link.compileOnly === true), "Rust module/use edges are compile-only, never runtime imports");
    assert.deepEqual(g.externalImports.filter((item) => item.file === "src/lib.rs").map((item) => [item.ecosystem, item.pkg]), [["crates.io", "serde"]], "external crates are dependency evidence while std remains builtin");

    const ep = (value) => String(value && typeof value === "object" ? value.id : value);
    assert.ok(g.links.some((link) => link.relation === "calls" && ep(link.source).includes("lib.rs#boot") && ep(link.target).includes("util.rs#run")), "aliased and qualified calls still resolve to the imported Rust symbol");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lang-rust: primitives, relative-path modules and use-bound aliases are not external crates", async () => {
  const dir = repoWith({
    "src/lib.rs": "pub mod wlan;",
    "src/wlan/mod.rs": "pub mod sys;\npub mod bss;",
    "src/wlan/sys.rs": "pub fn init() {}\npub struct Widget;",
    "src/wlan/bss.rs": `
      use super::sys::{self, Widget};
      use anyhow::Result;
      pub fn rate(raw: u16) -> f64 { f64::from(raw & 0x7fff) * 0.5 }
      pub fn go() -> Result<()> { let _ = sys::init(); let _w = Widget; Ok(()) }
    `,
  });
  try {
    const g = await buildInternalGraph(dir);
    const externals = g.externalImports.filter((item) => item.file === "src/wlan/bss.rs").map((item) => item.pkg).sort();
    assert.deepEqual(externals, ["anyhow"], "only the real crate is external: the f64 primitive, the super::sys module and the in-scope sys/Widget aliases are not crates");
    assert.ok(g.links.some((link) => link.relation === "imports" && link.source === "src/wlan/bss.rs" && link.target === "src/wlan/sys.rs"), "super::sys still resolves to the sibling module file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lang-rust: resolves non-mod-rs children, inline #[path], and main.rs crate roots", async () => {
  const dir = repoWith({
    "crate/src/main.rs": "mod service; fn main() { crate::service::start(); }",
    "crate/src/service.rs": `
      mod model;
      #[path = "sibling.rs"] mod sibling;
      mod inline { #[path = "other.rs"] mod custom; }
      pub fn start() { self::model::load(); }
    `,
    "crate/src/service/model.rs": "pub fn load() {}",
    "crate/src/sibling.rs": "pub struct Sibling;",
    "crate/src/service/inline/other.rs": "pub struct Other;",
  });
  try {
    const g = await buildInternalGraph(dir);
    const imports = g.links.filter((link) => link.relation === "imports");
    assert.ok(imports.length > 0 && imports.every((link) => link.compileOnly === true));
    const pairs = new Set(imports.map((link) => `${link.source}>${link.target}`));
    assert.ok(pairs.has("crate/src/main.rs>crate/src/service.rs"), "main.rs is a crate root for mod and crate:: paths");
    assert.ok(pairs.has("crate/src/service.rs>crate/src/service/model.rs"), "foo.rs owns default children below foo/");
    assert.ok(pairs.has("crate/src/service.rs>crate/src/sibling.rs"), "top-level #[path] in a non-mod-rs file is source-directory relative");
    assert.ok(pairs.has("crate/src/service.rs>crate/src/service/inline/other.rs"), "inline #[path] includes non-mod-rs and inline module directories");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lang-rust: #[cfg(test)] modules and #[test]/#[bench] functions carry test_only", async () => {
  const dir = repoWith({
    "src/lib.rs": `pub fn prod_fn() -> u32 { 1 }

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture { n: u32 }

    fn helper() -> u32 { 2 }

    #[test]
    fn checks_prod_fn() {
        assert_eq!(prod_fn(), 1);
    }
}

#[cfg(all(test, feature = "slow"))]
fn gated_helper() {}

#[cfg(any(test, feature = "extra"))]
pub fn dual_use() {}

#[cfg(not(test))]
pub fn prod_only() {}

#[cfg(test)]
impl Fixture2 {
    fn make() -> u32 { 3 }
}
pub struct Fixture2;
`,
    "src/timer.rs": `#[tokio::test]
async fn waits() {}

#[bench]
fn bench_hot(b: &mut Bencher) {}

#[derive(Debug)]
#[cfg(test)]
struct Stacked;

pub fn run() {}
`,
  });
  try {
    const g = await buildInternalGraph(dir);
    const sym = (name) => g.nodes.find((n) => String(n.id).includes("#" + name + "@"));
    assert.equal(sym("prod_fn").test_surface, undefined, "plain production fn stays unclassified");
    assert.equal(sym("tests").test_surface, true, "the #[cfg(test)] mod symbol itself");
    assert.equal(sym("Fixture").test_surface, true, "struct inside a #[cfg(test)] mod");
    assert.equal(sym("helper").test_surface, true, "helper fn inside a #[cfg(test)] mod");
    assert.equal(sym("checks_prod_fn").test_surface, true, "#[test] fn inside a #[cfg(test)] mod");
    assert.equal(sym("gated_helper").test_surface, true, "cfg(all(test, ...)) compiles only under test");
    assert.equal(sym("dual_use").test_surface, undefined, "cfg(any(test, ...)) also ships in production builds");
    assert.equal(sym("prod_only").test_surface, undefined, "cfg(not(test)) is production-only");
    assert.equal(sym("make").test_surface, true, "method inside a #[cfg(test)] impl block");
    assert.equal(sym("Fixture2").test_surface, undefined, "the production type itself stays unclassified");
    assert.equal(sym("waits").test_surface, true, "#[tokio::test] harness attribute");
    assert.equal(sym("bench_hot").test_surface, true, "#[bench] function");
    assert.equal(sym("Stacked").test_surface, true, "cfg(test) recognized behind another attribute");
    assert.equal(sym("run").test_surface, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
