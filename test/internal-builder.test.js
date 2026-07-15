import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalGraph } from "../src/graph/internal-builder.js";

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "rl-build-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("internal-builder: export flag is set for exported function/class/const and a method of an exported class", async () => {
  const dir = repoWith({
    "src/a.js":
      "export function exportedFn() { return 1; }\n" +
      "function plainFn() { return 2; }\n" +
      "export const exportedConst = () => 3;\n" +
      "export class ExportedCls { doThing() { return 4; } }\n" +
      "class PlainCls { hidden() { return 5; } }\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    assert.equal(g.repoBoundaryV, 1, "new graphs carry the repository-boundary marker");
    const sym = (name) => g.nodes.find((n) => String(n.id).includes("#" + name + "@"));
    assert.equal(sym("exportedFn").exported, true, "export function → exported");
    assert.equal(sym("exportedConst").exported, true, "export const → exported");
    assert.equal(sym("ExportedCls").exported, true, "export class → exported");
    assert.equal(sym("doThing").exported, true, "method of an EXPORTED class keeps the exported flag (≤ hop cap)");
    assert.ok(!sym("plainFn").exported, "non-exported function is not flagged");
    assert.ok(!sym("hidden").exported, "method of a non-exported class is not flagged");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: deeply-nested JS does not hang (bounded isExportedDecl, not O(depth^3))", async () => {
  // ~700 nested functions — the exact O(depth^3) .parent-walk trigger; the unbounded version took minutes.
  let body = "return 1;";
  for (let i = 700; i > 0; i--) body = "const f" + i + " = () => { function g" + i + "(){ " + body + " } return g" + i + "; };";
  const dir = repoWith({ "src/deep.js": "function root(){ " + body + " }\n", "src/ok.js": "export function hi(){ return 0; }\n" });
  try {
    const t0 = Date.now();
    const g = await buildInternalGraph(dir);
    const ms = Date.now() - t0;
    assert.ok(g.nodes.length > 0, "build produced nodes");
    assert.equal(g.nodes.find((n) => String(n.id).includes("#hi@")).exported, true, "sibling export still detected");
    assert.ok(ms < 15000, `deep-nesting build finished quickly (${ms}ms) — no O(depth^3) hang`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: a symlink/junction cycle does not make the walk recurse forever", async (t) => {
  const dir = repoWith({ "src/a.js": "export function a(){ return 1; }\n" });
  // a symlink pointing back at the repo root would loop forever with a naive statSync walk
  try { symlinkSync(dir, join(dir, "src", "loop"), "junction"); }
  catch { return t.skip("symlink/junction not permitted in this environment"); }
  try {
    const t0 = Date.now();
    const g = await buildInternalGraph(dir);
    assert.ok(g.nodes.some((n) => String(n.id).includes("#a@")), "still indexes real files");
    assert.ok(Date.now() - t0 < 15000, "cycle-safe walk terminates");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: a symlink or junction cannot index files outside the repository", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "wx-build-boundary-"));
  const repo = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repo, "src", "inside.js"), "export function inside(){ return 1; }\n");
  writeFileSync(join(outside, "secret.js"), "export function outsideSecret(){ return 2; }\n");
  try {
    try { symlinkSync(outside, join(repo, "linked"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) return t.skip(`link creation is unavailable: ${error.code}`);
      throw error;
    }
    const graph = await buildInternalGraph(repo);
    assert.ok(graph.nodes.some((node) => String(node.id).includes("#inside@")));
    assert.ok(!graph.nodes.some((node) => String(node.id).includes("outsideSecret") || String(node.source_file).includes("linked")));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
