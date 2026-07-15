import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { childProcessEnv } from "../src/child-env.js";

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

run(process.execPath, [mcpbCli, "validate", stage]);
run(process.execPath, [mcpbCli, "pack", stage, output]);
run(process.execPath, [mcpbCli, "info", output]);

process.stdout.write(`Built ${output}\n`);
