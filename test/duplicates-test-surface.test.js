import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeDuplicates } from "../src/analysis/duplicates.js";

// Rust inline tests (`#[cfg(test)]`) live inside production files, so a path check alone treats them as
// production. The graph flags the symbol with test_surface; the duplicate scanner must honour it so a pair
// of `#[test]` functions is never reported as a production clone under the default skip-tests behaviour.
test("duplicates: inline test symbols in a production file are flagged test via test_surface", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-dup-ts-"));
  const body = (name) => `fn ${name}(a: u32, b: u32) -> u32 {\n    let mut total = 0;\n    for i in a..b { total += i * 2 + 1; }\n    total\n}`;
  const rel = "src/analyze.rs";
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${body("compute")}\n\n${body("check_compute")}\n`);
  const nodes = [
    { id: rel, label: "analyze.rs", file_type: "code", source_file: rel, source_location: "L1" },
    { id: `${rel}#compute@1`, label: "compute()", file_type: "code", source_file: rel, source_location: "L1" },
    { id: `${rel}#check_compute@7`, label: "check_compute()", file_type: "code", source_file: rel, source_location: "L7", test_surface: true },
  ];
  const graphJson = join(dir, "graph.json");
  writeFileSync(graphJson, JSON.stringify({ nodes, links: [] }));
  try {
    const r = computeDuplicates(dir, graphJson, { minTokens: 12 });
    const prod = r.frags.find((f) => f.id.includes("#compute@"));
    const inlineTest = r.frags.find((f) => f.id.includes("#check_compute@"));
    assert.equal(prod?.test, false, "a production symbol in a production path is not a test");
    assert.equal(inlineTest?.test, true, "the inline test symbol is flagged test via test_surface, despite the production path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
