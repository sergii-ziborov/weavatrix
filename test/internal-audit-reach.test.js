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
