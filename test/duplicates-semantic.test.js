import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDuplicates } from "../src/analysis/duplicates.js";

// Two files defining the SAME-NAME function with DIFFERENT bodies — invisible to token-clone pairing
// (low jaccard), surfaced by the semantic name-twin pass as a divergence hazard.
const BODY_A = `export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = String(value).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(String(value).trim());
  }
  return result;
}`;

const BODY_B = `export function uniqueStrings(values) {
  const sorted = [...new Set(values.map((entry) => entry.normalize()))];
  sorted.sort((left, right) => left.localeCompare(right));
  const filtered = sorted.filter((entry) => entry.length > 0 && entry.length < 512);
  return filtered.map((entry) => entry.padEnd(1, " ").trimEnd());
}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wx-dup-sem-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), BODY_A + "\n");
  writeFileSync(join(dir, "src", "b.ts"), BODY_B + "\n");
  const graph = {
    nodes: [
      { id: "src/a.ts", label: "a.ts", source_file: "src/a.ts", file_type: "code" },
      { id: "src/b.ts", label: "b.ts", source_file: "src/b.ts", file_type: "code" },
      { id: "src/a.ts#uniqueStrings@1", label: "uniqueStrings()", source_file: "src/a.ts", source_location: "L1" },
      { id: "src/b.ts#uniqueStrings@1", label: "uniqueStrings()", source_file: "src/b.ts", source_location: "L1" },
    ],
    links: [],
  };
  writeFileSync(join(dir, "graph.json"), JSON.stringify(graph));
  return dir;
}

test("find_duplicates semantic: same-name cross-file symbols surface with low similarity (divergent copies)", () => {
  const dir = fixture();
  try {
    const plain = computeDuplicates(dir, join(dir, "graph.json"));
    assert.ok(!("nameTwins" in plain), "nameTwins is opt-in");

    const res = computeDuplicates(dir, join(dir, "graph.json"), { nameTwins: true });
    const twin = (res.nameTwins || []).find((t) => t.label === "uniqueStrings");
    assert.ok(twin, "uniqueStrings name-twin group found");
    assert.equal(twin.files, 2);
    assert.equal(twin.members.length, 2);
    assert.equal(twin.pairs.length, 1);
    assert.equal(twin.pairs[0].similarity, twin.simMax);
    assert.ok(twin.simMax < 60, `divergent bodies score low similarity (got ${twin.simMax}%)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
