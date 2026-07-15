import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalGraph } from "../src/graph/internal-builder.js";

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "wx-cs-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const GREETER = `using System;

namespace Demo {
  public interface IGreeter { string Greet(string name); }

  public class Greeter : IGreeter {
    private int count;
    public string Name { get; set; }
    public Greeter() { count = 0; }
    public string Greet(string name) {
      count++;
      return Helper.Format(name);
    }
  }

  public record Person(string First);
  public enum Mode { Fast, Slow }
}
`;

const HELPER = `namespace Demo {
  public static class Helper {
    public static string Format(string s) { return "hi " + s; }
  }
}
`;

test("lang-csharp: symbols, heritage, and same-folder cross-file calls", async () => {
  const dir = repoWith({ "src/Greeter.cs": GREETER, "src/Helper.cs": HELPER });
  try {
    const g = await buildInternalGraph(dir);
    const sym = (name) => g.nodes.find((n) => String(n.id).includes("#" + name + "@"));
    // classes / interface / enum / record / members
    for (const name of ["Greeter", "IGreeter", "Helper", "Mode", "Person", "Greet", "Format", "Name", "count"]) {
      assert.ok(sym(name), `symbol ${name} extracted`);
    }
    const ep = (v) => String(v && typeof v === "object" ? v.id : v);
    const edge = (rel, srcPart, tgtPart) =>
      g.links.find((l) => l.relation === rel && ep(l.source).includes(srcPart) && ep(l.target).includes(tgtPart));
    // C# folder ≈ namespace: the cross-file call resolves through the same-dir scope map
    assert.ok(edge("calls", "Greeter.cs#Greet", "Helper.cs#Format"), "cross-file call Greet → Helper.Format");
    assert.ok(edge("inherits", "#Greeter@", "#IGreeter@"), "base_list heritage Greeter → IGreeter");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
