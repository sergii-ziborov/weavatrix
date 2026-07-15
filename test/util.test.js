import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRead, MAX_FILE_BYTES } from "../src/util.js";

test("safeRead: returns file content for a normal file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-util-"));
  try {
    const f = join(dir, "a.txt");
    writeFileSync(f, "hello");
    assert.equal(safeRead(f), "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeRead: returns '' for missing paths and directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-util-"));
  try {
    assert.equal(safeRead(join(dir, "nope.txt")), "");
    assert.equal(safeRead(dir), ""); // a directory is not a file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeRead: skips oversized files entirely instead of truncating", () => {
  const dir = mkdtempSync(join(tmpdir(), "wx-util-"));
  try {
    const f = join(dir, "big.txt");
    writeFileSync(f, "x".repeat(MAX_FILE_BYTES + 1));
    assert.equal(safeRead(f), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
