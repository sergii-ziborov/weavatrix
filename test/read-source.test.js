import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

test("read_source: rejects traversal outside the repository", () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-rs-boundary-"));
  const repo = join(parent, "repo");
  mkdirSync(repo);
  writeFileSync(join(parent, "secret.txt"), "outside-secret\n");
  try {
    const deps = { repoRoot: repo, resolveNode: () => null, isSymbol: () => false };
    const out = readSource(deps, null, { path: "../secret.txt" });
    assert.match(out, /path escapes the repository root/);
    assert.ok(!out.includes("outside-secret"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("read_source: rejects absolute paths", () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-rs-absolute-"));
  const repo = join(parent, "repo");
  mkdirSync(repo);
  const secret = join(parent, "secret.txt");
  writeFileSync(secret, "absolute-secret\n");
  try {
    const deps = { repoRoot: repo, resolveNode: () => null, isSymbol: () => false };
    const out = readSource(deps, null, { path: secret });
    assert.match(out, /path escapes the repository root/);
    assert.ok(!out.includes("absolute-secret"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("read_source: rejects a poisoned graph source_file", () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-rs-graph-"));
  const repo = join(parent, "repo");
  mkdirSync(repo);
  writeFileSync(join(parent, "secret.txt"), "graph-secret\n");
  try {
    const node = { id: "poisoned#node@1", label: "poisoned", source_file: "../secret.txt", source_location: "L1" };
    const deps = { repoRoot: repo, resolveNode: () => node, isSymbol: () => true };
    const out = readSource(deps, { nodes: [node], links: [] }, { label: "poisoned" });
    assert.match(out, /path escapes the repository root/);
    assert.ok(!out.includes("graph-secret"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("read_source: rejects a poisoned graph node id when source_file is absent", () => {
  const parent = mkdtempSync(join(tmpdir(), "wx-rs-graph-id-"));
  const repo = join(parent, "repo");
  mkdirSync(repo);
  writeFileSync(join(parent, "secret.txt"), "graph-id-secret\n");
  try {
    const node = { id: "../secret.txt#poisoned@1", label: "poisoned", source_location: "L1" };
    const deps = { repoRoot: repo, resolveNode: () => node, isSymbol: () => true };
    const out = readSource(deps, { nodes: [node], links: [] }, { label: "poisoned" });
    assert.match(out, /path escapes the repository root/);
    assert.ok(!out.includes("graph-id-secret"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("read_source: rejects a directory and oversized source file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-rs-limits-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "large.js"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const deps = { repoRoot: dir, resolveNode: () => null, isSymbol: () => false };
    assert.match(readSource(deps, null, { path: "src" }), /not a regular file/);
    assert.match(readSource(deps, null, { path: "src/large.js" }), /2 MB source-read limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read_source: rejects a symlink or junction that resolves outside the repository", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "wx-rs-link-"));
  const repo = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "linked-secret\n");
  try {
    try {
      symlinkSync(outside, join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t.skip(`link creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const deps = { repoRoot: repo, resolveNode: () => null, isSymbol: () => false };
    const out = readSource(deps, null, { path: "linked/secret.txt" });
    assert.match(out, /path escapes the repository root/);
    assert.ok(!out.includes("linked-secret"));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("read_source: allows a symlink or junction whose target remains inside the repository", (t) => {
  const repo = repoWithHundredLines();
  try {
    try {
      symlinkSync(join(repo, "src"), join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t.skip(`link creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const deps = { repoRoot: repo, resolveNode: () => null, isSymbol: () => false };
    const out = readSource(deps, null, { path: "linked/big.txt", start_line: 42, before: 0, after: 1 });
    assert.match(out, />\s*42\s+line-42/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
