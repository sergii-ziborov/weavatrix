import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectConfigTexts, collectNonRuntimeRoots, collectPackageScopes, collectSourceTexts, listRepoFiles } from "../src/analysis/internal-audit.collect.js";

test("audit collectors honor .gitignore and discover nested manifests/aliases", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-files-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "web", "app"), { recursive: true });
    mkdirSync(join(repo, "release", "win-unpacked"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "release/\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "~/*": ["src/*"] } } }));
    writeFileSync(join(repo, "src", "main.ts"), "export const main = true\n");
    writeFileSync(join(repo, "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "^15" } }));
    writeFileSync(join(repo, "web", "tsconfig.app.json"), `{ // jsonc\n "compilerOptions": { "paths": { "@/*": ["./*"] } },\n "include": ["**/*.ts"],\n}\n`);
    writeFileSync(join(repo, "web", "postcss.config.mjs"), `export default { plugins: { "@tailwindcss/postcss": {} } };\n`);
    writeFileSync(join(repo, "web", "app", "page.tsx"), "export default function Page(){}\n");
    writeFileSync(join(repo, "release", "win-unpacked", "bundle.js"), "const generated = true\n");
    writeFileSync(join(repo, "release", "win-unpacked", "package.json"), JSON.stringify({ name: "generated" }));
    const init = spawnSync("git", ["init", "--quiet"], { cwd: repo, windowsHide: true });
    if (init.status !== 0) { t.skip("git unavailable"); return; }

    const files = listRepoFiles(repo);
    assert.ok(files.includes("web/app/page.tsx"));
    assert.ok(!files.some((f) => f.startsWith("release/")));
    const scopes = collectPackageScopes(repo, { name: "root" });
    assert.deepEqual(scopes.map((s) => s.manifest).sort(), ["package.json", "web/package.json"]);
    assert.equal(scopes.find((s) => s.root === "web").aliases[0].key, "@/*");
    assert.deepEqual(scopes.find((s) => s.root === "").aliases.map((a) => a.key), ["~/*"], "root scope never inherits a child tsconfig alias");
    const sources = collectSourceTexts(repo, { nodes: [], links: [] });
    assert.ok(sources.has("src/main.ts"));
    assert.ok(!sources.has("release/win-unpacked/bundle.js"));
    assert.match(collectConfigTexts(repo).get("web/postcss.config.mjs"), /@tailwindcss\/postcss/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("audit collectors infer conventional and explicitly documented template catalogs", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-catalogs-"));
  try {
    mkdirSync(join(repo, "examples", "demo"), { recursive: true });
    mkdirSync(join(repo, "library", "components"), { recursive: true });
    mkdirSync(join(repo, "src", "components"), { recursive: true });
    mkdirSync(join(repo, "custom"), { recursive: true });
    writeFileSync(join(repo, "examples", "demo", "main.ts"), "export const demo = true\n");
    writeFileSync(join(repo, "library", "README.md"), "Reusable patterns and components. These are templates, not deployed applications.\n");
    writeFileSync(join(repo, "library", "components", "Card.tsx"), "export const Card = () => null\n");
    writeFileSync(join(repo, "src", "components", "README.md"), "Reusable runtime components for the application.\n");
    writeFileSync(join(repo, "src", "components", "Card.tsx"), "export const Card = () => null\n");
    writeFileSync(join(repo, "custom", "example.ts"), "export const custom = true\n");
    const roots = collectNonRuntimeRoots(repo, { nonRuntimeRoots: ["custom", "../escape"] });
    assert.deepEqual(roots, ["custom", "examples", "library"]);
    assert.ok(!roots.includes("src/components"), "a normal reusable runtime component README is not enough to suppress findings");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
