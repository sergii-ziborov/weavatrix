import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { childProcessEnv } from "../src/child-env.js";
import { createRuntimeFixture, verifyMcpRuntime } from "./mcp-runtime-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-mcpb");
const stage = join(dist, "stage");
const output = join(dist, "weavatrix.mcpb");
const npmCli = process.env.npm_execpath;
const mcpbCli = join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false, env: childProcessEnv() });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function runNpm(args, cwd) {
  if (npmCli && existsSync(npmCli)) return run(process.execPath, [npmCli, ...args], cwd);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

if (!existsSync(mcpbCli)) throw new Error("@anthropic-ai/mcpb is not installed; run npm ci first");

for (const file of ["package.json", "package-lock.json", "LICENSE", "README.md", "SECURITY.md"]) {
  copyFileSync(join(root, file), join(stage, file));
}
for (const dir of ["bin", "src", "skill"]) {
  cpSync(join(root, dir), join(stage, dir), { recursive: true });
}
copyFileSync(join(root, "mcpb", "manifest.json"), join(stage, "manifest.json"));
copyFileSync(join(root, "site", "apple-touch-icon.png"), join(stage, "icon.png"));

runNpm(["ci", "--omit=dev", "--ignore-scripts"], stage);

const stagedPrecisionDependencies = {
  typescript: {
    version: "5.9.3",
    files: [
      "package.json",
      "bin/tsserver",
      "lib/tsserver.js",
      "lib/_tsserver.js",
      "lib/typescript.js",
      "LICENSE.txt",
      "ThirdPartyNoticeText.txt",
    ],
  },
  "typescript-language-server": {
    version: "4.4.1",
    files: ["package.json", "lib/cli.mjs", "LICENSE"],
  },
};
for (const [name, expectedPackage] of Object.entries(stagedPrecisionDependencies)) {
  const packageRoot = join(stage, "node_modules", name);
  const packagePath = join(packageRoot, "package.json");
  if (!existsSync(packagePath)) throw new Error(`MCPB stage is missing production dependency ${name}`);
  const stagedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  if (stagedPackage.version !== expectedPackage.version) {
    throw new Error(`MCPB stage has ${name} ${stagedPackage.version || "(missing)"}; expected ${expectedPackage.version}`);
  }
  for (const relativePath of expectedPackage.files) {
    const requiredPath = join(packageRoot, relativePath);
    if (!existsSync(requiredPath) || !statSync(requiredPath).isFile()) {
      throw new Error(`MCPB stage is missing required ${name} runtime/license file: ${relativePath}`);
    }
  }
}

// Resolve and initialize the semantic provider from the staged portable bundle, not this checkout.
// File-existence checks alone can miss a broken package entry point or a tsserver launcher whose
// transitive runtime file was pruned.
const stagedProviderUrl = pathToFileURL(join(stage, "src", "precision", "typescript-lsp-provider.js")).href;
run(process.execPath, [
  "--input-type=module",
  "--eval",
  `const {createTypeScriptLspClient}=await import(${JSON.stringify(stagedProviderUrl)});let client;try{client=await createTypeScriptLspClient({repoRoot:${JSON.stringify(stage)},timeoutMs:10000});if(client.version!==${JSON.stringify(stagedPrecisionDependencies["typescript-language-server"].version)}||client.typescriptVersion!==${JSON.stringify(stagedPrecisionDependencies.typescript.version)})throw new Error("staged precision provider version mismatch");}finally{await client?.close();}`,
], stage);

// Reproduce the dangerous npm-hoisted layout: Weavatrix/TLS/TypeScript and a repository-controlled
// tsserver plugin are siblings under one node_modules. Precision must reject the configured plugin
// before spawning TLS; otherwise TypeScript would execute arbitrary repository JavaScript.
const securityFixture = join(stage, ".precision-security-fixture");
const maliciousPlugin = join(stage, "node_modules", "evil-plugin");
const pluginSentinel = join(stage, ".precision-plugin-loaded");
try {
  mkdirSync(join(securityFixture, "src"), { recursive: true });
  mkdirSync(maliciousPlugin, { recursive: true });
  const securitySource = "function answer() { return 42 }\nexport const value = answer()\n";
  writeFileSync(join(securityFixture, "src", "main.ts"), securitySource);
  writeFileSync(join(securityFixture, "tsconfig.json"), JSON.stringify({
    compilerOptions: { plugins: [{ name: "evil-plugin" }] },
    include: ["src/**/*.ts"],
  }));
  writeFileSync(join(maliciousPlugin, "package.json"), JSON.stringify({
    name: "evil-plugin", version: "1.0.0", main: "index.js",
  }));
  writeFileSync(join(maliciousPlugin, "index.js"), [
    `require("node:fs").writeFileSync(${JSON.stringify(pluginSentinel)}, "loaded")`,
    "module.exports = () => ({create: info => info.languageService})",
    "",
  ].join("\n"));
  const stagedOverlayUrl = pathToFileURL(join(stage, "src", "precision", "lsp-overlay.js")).href;
  run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const {createHash}=await import("node:crypto");const {existsSync}=await import("node:fs");const {buildLspPrecisionOverlay}=await import(${JSON.stringify(stagedOverlayUrl)});const source=${JSON.stringify(securitySource)};const file="src/main.ts";const target=file+"#answer@1";const graph={extractorSchemaV:3,graphBuildMode:"full",graphBuildScope:"",graphPrecisionMode:"lsp",graphRevision:createHash("sha256").update(source).digest("hex"),fileHashes:{[file]:createHash("sha256").update(source).digest("hex")},nodes:[{id:file,source_file:file,file_type:"code"},{id:target,label:"answer()",source_file:file,file_type:"code",symbol_kind:"function",selection_start:{line:0,character:9},source_range:{start:{line:0,character:0},end:{line:0,character:31}}}],links:[{source:file,target,relation:"contains",provenance:"EXTRACTED"}]};const overlay=await buildLspPrecisionOverlay({repoRoot:${JSON.stringify(securityFixture)},graph,timeoutMs:10000});if(overlay.state!=="UNAVAILABLE"||!/plugins are not allowed/i.test(String(overlay.reason||"")))throw new Error("configured tsserver plugin was not rejected before provider startup");if(existsSync(${JSON.stringify(pluginSentinel)}))throw new Error("repository-local tsserver plugin executed in staged hoisted layout");`,
  ], stage);
} finally {
  rmSync(securityFixture, { recursive: true, force: true });
  rmSync(maliciousPlugin, { recursive: true, force: true });
  rmSync(pluginSentinel, { force: true });
}

// tree-sitter-wasms ships many grammars Weavatrix does not support. Keep the bundle's runtime
// surface and size limited to the languages declared by the builder.
const grammarDir = join(stage, "node_modules", "tree-sitter-wasms", "out");
const supportedGrammars = new Set([
  "tree-sitter-javascript.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-c_sharp.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-html.wasm",
  "tree-sitter-css.wasm",
]);
for (const file of readdirSync(grammarDir)) {
  if (file.endsWith(".wasm") && !supportedGrammars.has(file)) unlinkSync(join(grammarDir, file));
}

// Start the staged portable runtime itself before it is packed. Static manifest/file checks cannot
// detect a stale catalog, a wrong capability argument, or a client-visible tools/list regression.
const runtimeSmoke = join(dist, "runtime-smoke");
try {
  mkdirSync(runtimeSmoke, { recursive: true });
  await verifyMcpRuntime({
    entryPoint: join(stage, "bin", "weavatrix-mcp.mjs"),
    repoRoot: createRuntimeFixture(runtimeSmoke),
    graphHome: join(runtimeSmoke, "graphs"),
    version: JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).version,
  });
} finally {
  rmSync(runtimeSmoke, { recursive: true, force: true });
}

run(process.execPath, [mcpbCli, "validate", stage]);
run(process.execPath, [mcpbCli, "pack", stage, output]);
run(process.execPath, [mcpbCli, "info", output]);

process.stdout.write(`Built ${output}\n`);
