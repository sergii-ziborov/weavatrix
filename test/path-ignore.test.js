import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filterWeavatrixIgnored, isWeavatrixIgnored, loadWeavatrixIgnore, parseWeavatrixIgnore } from "../src/path-ignore.js";

test("weavatrixignore supports directories, globstars, anchors and ordered re-includes", () => {
  const rules = parseWeavatrixIgnore(`
# generated and noisy E2E fixtures
test-e2e/
**/generated/*.ts
/private/**
!test-e2e/keep.ts
`);
  assert.equal(isWeavatrixIgnored("test-e2e/cypress/a.ts", rules), true);
  assert.equal(isWeavatrixIgnored("test-e2e/keep.ts", rules), false);
  assert.equal(isWeavatrixIgnored("src/generated/client.ts", rules), true);
  assert.equal(isWeavatrixIgnored("nested/private/a.ts", rules), false);
  assert.equal(isWeavatrixIgnored("private/a.ts", rules), true);
});

test("repository filter applies .weavatrixignore to relative and absolute file lists", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-ignore-"));
  try {
    writeFileSync(join(root, ".weavatrixignore"), "fixtures/\n");
    assert.deepEqual(filterWeavatrixIgnored(root, ["src/a.ts", "fixtures/a.ts"]), ["src/a.ts"]);
    assert.deepEqual(filterWeavatrixIgnored(root, [join(root, "src", "a.ts"), join(root, "fixtures", "a.ts")]), [join(root, "src", "a.ts")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository filter refuses an external .weavatrixignore symlink", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "weavatrix-ignore-boundary-"));
  const root = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  try {
    const target = join(outside, "rules.txt");
    writeFileSync(target, "src/\n");
    try {
      symlinkSync(target, join(root, ".weavatrixignore"), "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "ENOTSUP") return t.skip("file symlinks are unavailable");
      throw error;
    }
    assert.deepEqual(loadWeavatrixIgnore(root), []);
    assert.deepEqual(filterWeavatrixIgnored(root, ["src/a.ts"]), ["src/a.ts"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
