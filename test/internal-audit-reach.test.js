import test from "node:test";
import assert from "node:assert/strict";
import { entryFiles } from "../src/analysis/internal-audit.reach.js";

const file = (source_file) => ({ id: source_file, source_file });

test("entry discovery: nested package scripts and Next conventions root reachability", () => {
  const graph = {
    nodes: [
      "scripts/dev.mjs",
      "web/scripts/seed.ts",
      "web/app/page.tsx",
      "web/app/api/items/[id]/route.ts",
      "web/app/robots.ts",
      "web/types/styles.d.ts",
      "web/lib/orphan.ts",
      "web/lib/declared.ts",
      "resources/runtime/worker.py",
    ].map(file),
    links: [],
  };
  const scopes = [
    { root: "web", pkg: { scripts: { seed: "tsx scripts/seed.ts" } } },
    { root: "", pkg: { scripts: { dev: "node scripts/dev.mjs --watch" } } },
  ];
  const entries = entryFiles(graph, scopes, new Set(), {
    declaredEntries: ["web/lib/declared.ts"],
    sources: new Map([["src/runtime.ts", `const scriptPath = resolveResource("worker.py")`]]),
  });
  for (const expected of [
    "scripts/dev.mjs",
    "web/scripts/seed.ts",
    "web/app/page.tsx",
    "web/app/api/items/[id]/route.ts",
    "web/app/robots.ts",
    "web/types/styles.d.ts",
    "web/lib/declared.ts",
    "resources/runtime/worker.py",
  ]) assert.ok(entries.has(expected), expected);
  assert.ok(!entries.has("web/lib/orphan.ts"));
});

test("entry discovery: local HTML assets are externally loaded entry surfaces", () => {
  const graph = {
    nodes: ["site/index.html", "site/graph-animation.js", "site/theme.css", "src/orphan.js"].map(file),
    links: [],
  };
  const entries = entryFiles(graph, {}, new Set(), {
    sources: new Map([
      ["site/index.html", `<script src="/graph-animation.js?v=2"></script><link href="theme.css#dark" rel="stylesheet">`],
    ]),
  });
  assert.ok(entries.has("site/graph-animation.js"));
  assert.ok(entries.has("site/theme.css"));
  assert.ok(!entries.has("src/orphan.js"));
});
