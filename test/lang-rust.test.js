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
    const ep = (v) => String(v && typeof v === "object" ? v.id : v);
    const call = g.links.find((l) => l.relation === "calls" && ep(l.source).includes("lib.rs#greet") && ep(l.target).includes("helper.rs#format_msg"));
    assert.ok(call, "cross-file call greet → format_msg via same-folder scope");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
