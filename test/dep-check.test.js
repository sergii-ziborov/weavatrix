// dep-check — pure dependency analysis over graph.externalImports vs package.json (P1 of
// DEPS_SECURITY_PLAN.md). Hand-built inputs, no filesystem (same pattern as dead-check.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDepFindings, computeScopedDepFindings } from "../src/analysis/dep-check.js";

const ext = (file, pkg, over = {}) => ({ file, spec: pkg, pkg, builtin: false, kind: "esm", line: 1, ...over });
const rules = (r, rule) => r.findings.filter((f) => f.rule === rule);
const pkgsOf = (r, rule) => rules(r, rule).map((f) => f.package);

test("dep-check: unused prod dep flagged; used dep not", () => {
  const r = computeDepFindings({
    externalImports: [ext("src/a.js", "axios")],
    pkg: { name: "me", dependencies: { axios: "^1", lodash: "^4" } },
  });
  assert.deepEqual(pkgsOf(r, "unused-dep"), ["lodash"]);
  assert.equal(rules(r, "unused-dep")[0].severity, "low");
});

test("dep-check: script- and config-mentioned deps stay alive; config-ecosystem devDeps never flagged", () => {
  const r = computeDepFindings({
    externalImports: [],
    pkg: {
      dependencies: { rimraf: "^5" },
      devDependencies: { "eslint-plugin-import": "^2", nodemon: "^3", husky: "^9" },
      scripts: { clean: "rimraf dist", dev: "nodemon src/index.js" },
    },
    configTexts: new Map([[".lintstagedrc", '{ "*.js": "husky" }']]),
  });
  // rimraf (script), nodemon (script), husky (config text) alive; eslint-plugin-import is ecosystem+dev → skipped
  assert.deepEqual(pkgsOf(r, "unused-dep"), []);
});

test("dep-check: unused devDep is info/low; @types follow their base package", () => {
  const r = computeDepFindings({
    externalImports: [ext("src/a.js", "react"), ext("src/b.js", "node:fs", { pkg: "fs", builtin: true })],
    pkg: {
      dependencies: { react: "^19" },
      devDependencies: { "@types/react": "^19", "@types/node": "^22", "@types/jest": "^29", "left-pad": "^1" },
    },
  });
  const unused = pkgsOf(r, "unused-dep");
  assert.ok(!unused.includes("@types/react"), "@types/react rides on used react");
  assert.ok(!unused.includes("@types/node"), "@types/node rides on builtin usage");
  assert.ok(unused.includes("@types/jest"), "@types/jest has no base usage");
  assert.ok(unused.includes("left-pad"));
  const lp = rules(r, "unused-dep").find((f) => f.package === "left-pad");
  assert.equal(lp.severity, "info");
  assert.equal(lp.confidence, "low");
});

test("dep-check: missing dep flagged with using files; self/workspace/builtin/declared excluded", () => {
  const r = computeDepFindings({
    externalImports: [
      ext("src/a.js", "phantom-pkg"), ext("src/b.js", "phantom-pkg", { line: 7 }),
      ext("src/c.js", "me"), ext("src/d.js", "@mono/ui"),
      ext("src/e.js", "fs", { builtin: true }), ext("src/f.js", "axios"),
    ],
    pkg: { name: "me", dependencies: { axios: "^1" } },
    workspacePkgNames: new Set(["@mono/ui"]),
  });
  assert.deepEqual(pkgsOf(r, "missing-dep"), ["phantom-pkg"]);
  const m = rules(r, "missing-dep")[0];
  assert.equal(m.severity, "medium");
  assert.equal(m.confidence, "high");
  assert.equal(m.evidence.length, 2);
});

test("dep-check: test-only missing dep downgraded to low", () => {
  const r = computeDepFindings({
    externalImports: [ext("test/a.test.js", "supertest"), ext("src/__tests__/b.js", "supertest")],
    pkg: { dependencies: {} },
  });
  const m = rules(r, "missing-dep")[0];
  assert.equal(m.package, "supertest");
  assert.equal(m.severity, "low");
});

test("dep-check: duplicate sections flagged; dev+peer lib pattern tolerated", () => {
  const r = computeDepFindings({
    externalImports: [ext("src/a.js", "dupe"), ext("src/a.js", "react")],
    pkg: {
      dependencies: { dupe: "^1" },
      devDependencies: { dupe: "^1", react: "^19" },
      peerDependencies: { react: ">=18" },
    },
  });
  assert.deepEqual(pkgsOf(r, "duplicate-dep"), ["dupe"]);
});

test("dep-check: unresolved imports become structure findings, capped with a true-count tail", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ file: `src/f${i}.js`, spec: `./gone-${i}`, kind: "esm", unresolved: true, line: 1 }));
  const r = computeDepFindings({ externalImports: many, pkg: {} });
  const u = rules(r, "unresolved-import");
  assert.equal(u.length, 101); // 100 unique + 1 "…and N more" tail
  assert.match(u[u.length - 1].title, /20 more/);
});

test("dep-check: an alias-shaped import with no local target remains unresolved", () => {
  const result = computeDepFindings({
    externalImports: [{ file: "web/app/page.tsx", spec: "@/missing", pkg: "@/missing", unresolved: true, line: 4 }],
    pkg: {},
    aliases: [{ key: "@/*", prefix: "@/", suffix: "" }],
  });
  assert.equal(rules(result, "missing-dep").length, 0, "alias is not an npm package");
  assert.equal(rules(result, "unresolved-import").length, 1, "broken alias target is still actionable");
});

test("dep-check: no package.json → no dep findings, no crash", () => {
  const r = computeDepFindings({ externalImports: [ext("a.py", "requests")], pkg: {} });
  assert.deepEqual(pkgsOf(r, "unused-dep"), []);
  assert.deepEqual(pkgsOf(r, "missing-dep"), ["requests"]); // imported-but-undeclared still surfaces
});

test("dep-check: nearest workspace manifest owns imports and tsconfig aliases are local", () => {
  const r = computeScopedDepFindings({
    externalImports: [
      ext("src/main.ts", "electron"),
      ext("web/app/page.tsx", "next"),
      ext("web/app/page.tsx", "@/components", { spec: "@/components/Card" }),
    ],
    packageScopes: [
      { root: "web", manifest: "web/package.json", pkg: { dependencies: { next: "^15" } }, aliases: [{ key: "@/*", prefix: "@/", suffix: "" }] },
      { root: "", manifest: "package.json", pkg: { dependencies: { electron: "^35" } }, aliases: [] },
    ],
  });
  assert.deepEqual(pkgsOf(r, "missing-dep"), []);
  assert.deepEqual(pkgsOf(r, "unused-dep"), []);
});

test("dep-check: Next.js keeps its required react-dom runtime peer", () => {
  const nextApp = computeDepFindings({
    pkg: {
      dependencies: { next: "^15", react: "^19", "react-dom": "^19" },
      devDependencies: { "@types/react-dom": "^19" },
    },
    externalImports: [ext("app/page.tsx", "react")],
  });
  assert.ok(!nextApp.findings.some((finding) => finding.rule === "unused-dep" && finding.package === "react-dom"));
  assert.ok(!nextApp.findings.some((finding) => finding.rule === "unused-dep" && finding.package === "@types/react-dom"));

  const plainReact = computeDepFindings({
    pkg: { dependencies: { react: "^19", "react-dom": "^19" } },
    externalImports: [ext("src/view.tsx", "react")],
  });
  assert.ok(plainReact.findings.some((finding) => finding.rule === "unused-dep" && finding.package === "react-dom"));
});

test("dep-check: framework build tools keep their package-local runtime peers", () => {
  const result = computeDepFindings({
    pkg: {
      dependencies: { vinext: "0.0.50" },
      devDependencies: {
        "@cloudflare/vite-plugin": "1.37.1",
        "@vitejs/plugin-react": "6.0.2",
        "@vitejs/plugin-rsc": "0.5.26",
        "react-server-dom-webpack": "19.2.6",
        vite: "8.0.13",
        wrangler: "4.92.0",
      },
    },
    externalImports: [ext("vite.config.ts", "vinext"), ext("vite.config.ts", "@cloudflare/vite-plugin")],
  });
  const unused = pkgsOf(result, "unused-dep");
  for (const peer of ["@vitejs/plugin-react", "@vitejs/plugin-rsc", "react-server-dom-webpack", "vite", "wrangler"]) {
    assert.ok(!unused.includes(peer), `${peer} is a declared framework peer`);
  }

  const unrelated = computeDepFindings({ pkg: { devDependencies: { vite: "^8", wrangler: "^4" } } });
  assert.deepEqual(pkgsOf(unrelated, "unused-dep").sort(), ["vite", "wrangler"]);
});

test("dep-check: nested config mentions do not suppress an unused root dependency", () => {
  const result = computeScopedDepFindings({
    externalImports: [],
    packageScopes: [
      { root: "web", manifest: "web/package.json", pkg: {}, aliases: [] },
      { root: "", manifest: "package.json", pkg: { dependencies: { next: "^15" } }, aliases: [] },
    ],
    configTexts: new Map([["web/next.config.mjs", "export default { experimental: { next: true } }"]]),
  });
  assert.ok(result.findings.some((finding) => finding.rule === "unused-dep" && finding.package === "next" && finding.scope === "."));
});
