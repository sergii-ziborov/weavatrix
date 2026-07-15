import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

test("internal-builder: only module declarations, not members of exported classes, are exports", async () => {
  const dir = repoWith({
    "src/a.js":
      "export function exportedFn() { return 1; }\n" +
      "function plainFn() { return 2; }\n" +
      "export const exportedConst = () => 3;\n" +
      "export class ExportedCls { doThing() { return 4; } }\n" +
      "class PlainCls { hidden() { return 5; } }\n" +
      "function doThing() { return 6; }\n" +
      "export { doThing };\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    assert.equal(g.repoBoundaryV, 1, "new graphs carry the repository-boundary marker");
    const sym = (name) => g.nodes.find((n) => String(n.id).includes("#" + name + "@"));
    assert.equal(sym("exportedFn").exported, true, "export function → exported");
    assert.equal(sym("exportedConst").exported, true, "export const → exported");
    assert.equal(sym("ExportedCls").exported, true, "export class → exported");
    assert.ok(!sym("doThing").exported, "public method is a class member, not a module export");
    assert.equal(sym("doThing").symbol_kind, "method");
    assert.equal(sym("doThing").member_of, "ExportedCls");
    assert.equal(sym("doThing").visibility, "public");
    const sameNamedModuleFn = g.nodes.find((n) => n.label === "doThing()" && n.source_location === "L6");
    assert.equal(sameNamedModuleFn.exported, true, "explicit export binds the module function, not a same-named class member");
    assert.ok(!sym("plainFn").exported, "non-exported function is not flagged");
    assert.ok(!sym("hidden").exported, "method of a non-exported class is not flagged");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: Git file universe excludes ignored output but includes tracked and untracked source", async (t) => {
  const dir = repoWith({
    ".gitignore": "release/\nignored.md\n",
    "src/tracked.ts": "export const tracked = 1;\n",
    "src/untracked.ts": "export const untracked = 2;\n",
    "release/win-unpacked/LICENSES.chromium.html": "<html>generated</html>\n",
    "release/tracked.ts": "export const intentionallyTracked = 3;\n",
    "ignored.md": "generated prose\n",
  });
  try {
    try {
      execFileSync("git", ["-C", dir, "init", "--quiet"], { stdio: "ignore" });
      execFileSync("git", ["-C", dir, "add", ".gitignore", "src/tracked.ts"], { stdio: "ignore" });
      execFileSync("git", ["-C", dir, "add", "-f", "release/tracked.ts"], { stdio: "ignore" });
    } catch { return t.skip("git is unavailable"); }
    const g = await buildInternalGraph(dir);
    const files = new Set(g.nodes.filter((n) => !String(n.id).includes("#")).map((n) => n.source_file));
    assert.ok(files.has("src/tracked.ts"), "tracked source is indexed");
    assert.ok(files.has("src/untracked.ts"), "untracked but nonignored source is indexed");
    assert.ok(files.has("release/tracked.ts"), "tracked files remain part of the repository even if their directory is ignored");
    assert.ok(!files.has("release/win-unpacked/LICENSES.chromium.html"), "ignored generated output is excluded");
    assert.ok(!files.has("ignored.md"), "custom ignored paths are excluded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: TS import and re-export edges preserve type/runtime metadata", async () => {
  const dir = repoWith({
    "src/types.ts": "export type Foo = { id: string };\n",
    "src/runtime.ts": "export const runtime = 1; export type Bar = string;\n",
    "src/use.ts":
      "import type { Foo } from './types';\n" +
      "import { type Foo as LocalFoo } from './types';\n" +
      "import { type Bar, runtime } from './runtime';\n" +
      "export type { Foo } from './types';\n" +
      "export { type Bar, runtime } from './runtime';\n" +
      "export const value: Foo | LocalFoo | Bar = { id: String(runtime) };\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    assert.equal(g.edgeTypesV, 2);
    const fromUse = g.links.filter((l) => l.source === "src/use.ts" && ["imports", "re_exports"].includes(l.relation));
    const edge = (line) => fromUse.find((l) => l.line === line);
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((line) => ({ line, relation: edge(line)?.relation, typeOnly: edge(line)?.typeOnly, specifier: edge(line)?.specifier })),
      [
        { line: 1, relation: "imports", typeOnly: true, specifier: "./types" },
        { line: 2, relation: "imports", typeOnly: true, specifier: "./types" },
        { line: 3, relation: "imports", typeOnly: false, specifier: "./runtime" },
        { line: 4, relation: "re_exports", typeOnly: true, specifier: "./types" },
        { line: 5, relation: "re_exports", typeOnly: false, specifier: "./runtime" },
      ],
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: nearest nested tsconfig owns aliases for each source file", async () => {
  const dir = repoWith({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    "src/util.ts": "export const rootUtil = 1;\n",
    "src/entry.ts": "import { rootUtil } from '@/util'; export const rootValue = rootUtil;\n",
    "web/tsconfig.json": "{\n  // workspace-local alias\n  \"compilerOptions\": { \"paths\": { \"@/*\": [\"./*\"], }, },\n  \"include\": [\"**/*.ts\",],\n}\n",
    "web/util.ts": "export const webUtil = 2;\n",
    "web/entry.ts": "import { webUtil } from '@/util'; export const webValue = webUtil;\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    const importedTarget = (source) => g.links.find((l) => l.source === source && l.relation === "imports")?.target;
    assert.equal(importedTarget("src/entry.ts"), "src/util.ts");
    assert.equal(importedTarget("web/entry.ts"), "web/util.ts");
    assert.ok(!g.externalImports.some((x) => x.spec === "@/util"), "resolved workspace aliases are not external dependencies");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: JSX component use references the imported declaration", async () => {
  const dir = repoWith({
    "src/Button.tsx": "export function Button(){ return <button />; }\n",
    "src/App.tsx": "import { Button } from './Button'; export function App(){ return <Button />; }\n",
    "src/AppNamespace.tsx": "import * as ui from './Button'; export function AppNamespace(){ return <ui.Button />; }\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    const button = g.nodes.find((n) => String(n.id).includes("src/Button.tsx#Button@"));
    const app = g.nodes.find((n) => String(n.id).includes("src/App.tsx#App@"));
    const appNamespace = g.nodes.find((n) => String(n.id).includes("src/AppNamespace.tsx#AppNamespace@"));
    assert.ok(g.links.some((l) => l.source === app.id && l.target === button.id && l.relation === "references" && l.usage === "jsx"));
    assert.ok(g.links.some((l) => l.source === appNamespace.id && l.target === button.id && l.relation === "references" && l.usage === "jsx"), "lowercase namespace JSX resolves through the imported namespace");
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
