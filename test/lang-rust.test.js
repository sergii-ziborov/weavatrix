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
    assert.ok(call, "cross-file call greet → format_msg via same-folder scope");
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
    assert.equal(g.externalImports.filter((item) => item.file === "src/lib.rs").length, 0, "Rust std/external uses are not misclassified by the internal module resolver");

    const ep = (value) => String(value && typeof value === "object" ? value.id : value);
    assert.ok(g.links.some((link) => link.relation === "calls" && ep(link.source).includes("lib.rs#boot") && ep(link.target).includes("util.rs#run")), "aliased and qualified calls still resolve to the imported Rust symbol");
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
