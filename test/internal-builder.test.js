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

test("internal-builder: symbol selections use zero-based UTF-16 LSP positions", async () => {
  const source = 'const marker = "😀漢"; export function target() { return marker; }\n';
  const dir = repoWith({ "src/unicode.ts": source });
  try {
    const graph = await buildInternalGraph(dir);
    const target = graph.nodes.find((node) => String(node.id).includes("#target@"));
    assert.ok(target, "the TypeScript declaration is indexed");
    assert.deepEqual(target.selection_start, {
      line: 0,
      character: source.indexOf("target"),
    });
    assert.equal(target.selection_end.character - target.selection_start.character, "target".length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("internal-builder: source ranges and call lines remain UTF-16 with Unicode before declarations", async () => {
  const targetLine = 'const marker = "\u{1F600}\u6F22"; export function target() { return marker; }';
  const callerLine = 'const prefix = "\u{1F680}\u5B57"; export function caller() { return target(); }';
  const dir = repoWith({ "src/unicode-ranges.ts": `${targetLine}\n${callerLine}\n` });
  try {
    const graph = await buildInternalGraph(dir);
    const target = graph.nodes.find((node) => String(node.id).includes("#target@"));
    const caller = graph.nodes.find((node) => String(node.id).includes("#caller@"));
    assert.deepEqual(target.selection_start, {line: 0, character: targetLine.indexOf("target")});
    assert.deepEqual(target.source_range.start, {line: 0, character: targetLine.indexOf("function")});
    assert.deepEqual(target.source_range.end, {line: 0, character: targetLine.length});
    assert.deepEqual(caller.selection_start, {line: 1, character: callerLine.indexOf("caller")});
    assert.deepEqual(caller.source_range.start, {line: 1, character: callerLine.indexOf("function")});
    assert.deepEqual(caller.source_range.end, {line: 1, character: callerLine.length});
    assert.ok(graph.links.some((link) => link.source === caller.id
      && link.target === target.id && link.relation === "calls" && link.line === 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("internal-builder: TypeScript NodeNext .js specifiers resolve to one source counterpart", async () => {
  const dir = repoWith({
    "src/http.ts": "export const get = (url: string) => url;\n",
    "src/use.ts": "import { get } from './http.js'; export const load = () => get('/api/users');\n",
  });
  try {
    const graph = await buildInternalGraph(dir);
    const load = graph.nodes.find((node) => String(node.id).includes("src/use.ts#load@"));
    const get = graph.nodes.find((node) => String(node.id).includes("src/http.ts#get@"));
    assert.ok(graph.links.some((link) => link.source === "src/use.ts" && link.target === "src/http.ts" && link.relation === "imports"));
    assert.ok(graph.links.some((link) => link.source === load.id && link.target === get.id && link.relation === "calls"));
    assert.ok(!graph.externalImports.some((item) => item.spec === "./http.js" && item.unresolved));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: JS/TS barrels resolve star, aliases, default, type-only, and cyclic chains to declaration origins", async () => {
  const dir = repoWith({
    "src/origin/component.tsx":
      "export default function Button(){ return <button />; }\n" +
      "export function run(){ return 1; }\n" +
      "export type Shape = { id: string };\n",
    "src/origin/extra.ts": "export function extra(){ return 2; }\n",
    "src/barrel/leaf.ts":
      "export { default as PublicButton, run as execute, type Shape as PublicShape } from '../origin/component';\n" +
      "export * from '../origin/extra';\n",
    "src/barrel/cycle-a.ts": "export * from './cycle-b';\nexport * from './leaf';\n",
    "src/barrel/cycle-b.ts": "export * from './cycle-a';\n",
    "src/barrel/index.ts":
      "export * from './cycle-a';\n" +
      "export { PublicButton as default } from './leaf';\n" +
      "export type { PublicShape as Shape } from './leaf';\n",
    "src/app.tsx":
      "import Button, { execute, extra } from './barrel';\n" +
      "export function App(){ execute(); extra(); return <Button />; }\n",
    "src/ns-app.tsx":
      "import * as ui from './barrel';\n" +
      "export function NamespaceApp(){ ui.execute(); return <ui.PublicButton />; }\n",
    "src/cycle-b-use.ts": "import { extra } from './barrel/cycle-b';\nexport function fromOtherCycleSide(){ return extra(); }\n",
    "src/type-use.ts": "import type { Shape } from './barrel';\nexport type Wrapped = Shape & { ok: true };\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    assert.equal(g.barrelResolutionV, 1);
    const id = (file, name) => g.nodes.find((node) => node.source_file === file && String(node.id).includes(`#${name}@`))?.id;
    const app = id("src/app.tsx", "App");
    const button = id("src/origin/component.tsx", "Button");
    const run = id("src/origin/component.tsx", "run");
    const extra = id("src/origin/extra.ts", "extra");
    const namespaceApp = id("src/ns-app.tsx", "NamespaceApp");
    const otherCycleSide = id("src/cycle-b-use.ts", "fromOtherCycleSide");
    assert.ok(g.links.some((link) => link.source === app && link.target === button && link.relation === "references" && link.usage === "jsx"), "default JSX resolves to the declaring component");
    assert.ok(g.links.some((link) => link.source === app && link.target === run && link.relation === "calls"), "named alias resolves to the declaring function");
    assert.ok(g.links.some((link) => link.source === app && link.target === extra && link.relation === "calls"), "star chain resolves through a safe re-export cycle");
    assert.ok(g.links.some((link) => link.source === namespaceApp && link.target === run && link.relation === "calls"), "namespace member call resolves through the barrel");
    assert.ok(g.links.some((link) => link.source === namespaceApp && link.target === button && link.relation === "references" && link.usage === "jsx"), "namespace JSX resolves through the barrel");
    assert.ok(g.links.some((link) => link.source === otherCycleSide && link.target === extra && link.relation === "calls"), "resolution is not path-dependent when either side of a star cycle is imported");

    const physical = g.links.find((link) => link.source === "src/app.tsx" && link.target === "src/barrel/index.ts" && link.relation === "imports");
    assert.equal(physical?.barrelProxy, true, "the physical barrel hop is retained and marked as a proxy");
    assert.ok(g.links.some((link) => link.source === "src/barrel/cycle-a.ts" && link.target === "src/barrel/cycle-b.ts" && link.relation === "re_exports" && link.barrelProxy), "cyclic physical re-export edge remains available to cycle analysis");
    assert.ok(g.links.some((link) => link.source === "src/barrel/cycle-b.ts" && link.target === "src/barrel/cycle-a.ts" && link.relation === "re_exports" && link.barrelProxy));
    assert.ok(g.links.some((link) => link.source === "src/app.tsx" && link.target === "src/origin/component.tsx" && link.relation === "imports" && link.semanticOrigin === true && link.typeOnly !== true));
    assert.ok(g.links.some((link) => link.source === "src/app.tsx" && link.target === "src/origin/extra.ts" && link.relation === "imports" && link.semanticOrigin === true));
    assert.ok(g.links.some((link) => link.source === "src/type-use.ts" && link.target === "src/origin/component.tsx" && link.semanticOrigin === true && link.typeOnly === true), "type-only is preserved across the full barrel chain");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: ambiguous export-star names are not guessed", async () => {
  const dir = repoWith({
    "src/left.ts": "export function clash(){ return 'left'; }\n",
    "src/right.ts": "export function clash(){ return 'right'; }\n",
    "src/index.ts": "export * from './left';\nexport * from './right';\n",
    "src/use.ts": "import { clash } from './index';\nexport function use(){ return clash(); }\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    const use = g.nodes.find((node) => node.source_file === "src/use.ts" && String(node.id).includes("#use@"));
    const clashTargets = new Set(g.nodes.filter((node) => String(node.id).includes("#clash@")).map((node) => node.id));
    assert.ok(!g.links.some((link) => link.source === use.id && clashTargets.has(link.target) && link.relation === "calls"), "call graph does not choose one conflicting origin");
    assert.ok(!g.links.some((link) => link.source === "src/use.ts" && ["src/left.ts", "src/right.ts"].includes(link.target) && link.semanticOrigin), "no semantic file edge is invented for an ambiguous export");
    assert.ok(g.links.some((link) => link.source === "src/use.ts" && link.target === "src/index.ts" && link.relation === "imports" && link.barrelProxy !== true), "unresolved physical dependency stays visible rather than disappearing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal-builder: default object facades resolve public members to local helper symbols", async () => {
  const dir = repoWith({
    "src/service.js":
      "function getSchema(){ return {ok: true}; }\n" +
      "function persist(){ return 1; }\n" +
      "export default { getSchema, save: persist };\n",
    "src/use.js":
      "import service from './service.js';\n" +
      "export function load(){ service.getSchema(); return service.save(); }\n",
  });
  try {
    const graph = await buildInternalGraph(dir);
    const id = (file, name) => graph.nodes.find((node) => node.source_file === file && String(node.id).includes(`#${name}@`))?.id;
    const load = id("src/use.js", "load");
    const getSchema = id("src/service.js", "getSchema");
    const persist = id("src/service.js", "persist");
    assert.ok(graph.links.some((link) => link.source === load && link.target === getSchema && link.relation === "calls"), "shorthand facade member resolves");
    assert.ok(graph.links.some((link) => link.source === load && link.target === persist && link.relation === "calls"), "aliased facade member resolves");
    assert.equal(graph.nodes.find((node) => node.id === getSchema)?.exported, true);
    assert.equal(graph.nodes.find((node) => node.id === persist)?.exported, true);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("internal-builder: Python receiver types and wildcard imports resolve without mixing same-named methods", async () => {
  const dir = repoWith({
    "pkg/__init__.py": "",
    "pkg/alpha.py": "class AlphaService:\n    def run(self):\n        return 'alpha'\n",
    "pkg/beta.py": "class BetaService:\n    def run(self):\n        return 'beta'\n",
    "pkg/helpers.py": "__all__ = ['wild_helper']\ndef wild_helper():\n    return 1\ndef hidden_helper():\n    return 2\n",
    "pkg/use.py":
      "from .alpha import AlphaService as Alpha\n" +
      "from .beta import BetaService\n" +
      "from .helpers import *\n" +
      "def use(alpha: Alpha, beta: BetaService):\n" +
      "    alpha.run()\n" +
      "    beta.run()\n" +
      "    local = Alpha()\n" +
      "    local.run()\n" +
      "    return wild_helper()\n",
  });
  try {
    const graph = await buildInternalGraph(dir);
    const symbol = (file, name, line) => graph.nodes.find((node) => node.source_file === file
      && String(node.id).includes(`#${name}@`) && (!line || node.source_location === `L${line}`));
    const use = symbol("pkg/use.py", "use");
    const alphaRun = symbol("pkg/alpha.py", "run");
    const betaRun = symbol("pkg/beta.py", "run");
    const wildcard = symbol("pkg/helpers.py", "wild_helper");
    assert.equal(alphaRun.member_of, "AlphaService");
    assert.equal(betaRun.member_of, "BetaService");
    const calls = graph.links.filter((link) => link.source === use.id && link.relation === "calls");
    assert.equal(calls.filter((link) => link.target === alphaRun.id).length, 2, "typed alias and constructor binding resolve to AlphaService.run");
    assert.equal(calls.filter((link) => link.target === betaRun.id).length, 1, "typed receiver resolves only to BetaService.run");
    assert.equal(calls.filter((link) => link.target === wildcard.id).length, 1, "unique __all__ wildcard symbol resolves");
    assert.ok(calls.filter((link) => [alphaRun.id, betaRun.id, wildcard.id].includes(link.target)).every((link) => link.provenance === "RESOLVED"));
  } finally { rmSync(dir, {recursive: true, force: true}); }
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
