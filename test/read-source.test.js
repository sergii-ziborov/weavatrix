import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSource } from "../src/mcp-source-tools.mjs";

function repoWithHundredLines() {
  const dir = mkdtempSync(join(tmpdir(), "wx-rs-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const lines = [];
  for (let i = 1; i <= 100; i++) lines.push(`line-${i}`);
  writeFileSync(join(dir, "src", "big.txt"), lines.join("\n"));
  return dir;
}

const noGraph = { repoRoot: null, resolveNode: () => null, isSymbol: () => false };

test("read_source: path + start_line anchors the window instead of the file head", () => {
  const dir = repoWithHundredLines();
  try {
    const deps = { repoRoot: dir, resolveNode: () => null, isSymbol: () => false };
    const out = readSource(deps, null, { path: "src/big.txt", start_line: 60, before: 2, after: 5 });
    assert.match(out, /lines 58-65 of 100/);
    assert.match(out, />\s*60\s+line-60/);
    assert.ok(!out.includes("line-1\n"), "head not shown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read_source: start_line past EOF clamps to the tail", () => {
  const dir = repoWithHundredLines();
  try {
    const deps = { repoRoot: dir, resolveNode: () => null, isSymbol: () => false };
    const out = readSource(deps, null, { path: "src/big.txt", start_line: 9999, before: 3, after: 40 });
    assert.match(out, /lines 97-100 of 100/);
    assert.match(out, /line-100/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read_source: label + matching path keeps the symbol's focus line (no silent head read)", () => {
  const dir = repoWithHundredLines();
  try {
    const node = { id: "src/big.txt#thing@42", label: "thing", source_file: "src/big.txt", source_location: "L42" };
    const deps = { repoRoot: dir, resolveNode: () => node, isSymbol: (id) => String(id).includes("#") };
    const out = readSource(deps, {}, { label: "thing", path: "src/big.txt", before: 1, after: 2 });
    assert.match(out, /lines 41-44 of 100/);
    assert.match(out, />\s*42\s+line-42/);
    assert.match(out, /thing\s+\[src\/big\.txt#thing@42\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read_source: unresolvable label falls back to the provided path instead of erroring", () => {
  const dir = repoWithHundredLines();
  try {
    const deps = { repoRoot: dir, resolveNode: () => null, isSymbol: () => false };
    const out = readSource(deps, {}, { label: "no-such-symbol", path: "src/big.txt", start_line: 10, before: 0, after: 1 });
    assert.match(out, /lines 10-11 of 100/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read_source: no label and no path is a clear error", () => {
  assert.match(readSource({ ...noGraph, repoRoot: tmpdir() }, null, {}), /Provide "label" or "path"/);
});
