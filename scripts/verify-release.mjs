import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const manifest = readJson("mcpb/manifest.json");
const server = readJson("server.json");
const expected = pkg.version;
const releaseNotesPath = resolve("docs", "releases", `v${expected}.md`);
const precisionRuntimeDependencies = {
  typescript: "5.9.3",
  "typescript-language-server": "4.4.1",
};

const versions = {
  "package-lock root": lock.version,
  "package-lock package": lock.packages?.[""]?.version,
  "MCPB manifest": manifest.version,
  "MCP Registry server": server.version,
  "MCP Registry npm package": server.packages?.[0]?.version,
};
for (const [label, version] of Object.entries(versions)) {
  if (version !== expected) throw new Error(`${label} version ${version || "(missing)"} does not match package ${expected}`);
}

for (const [name, version] of Object.entries(precisionRuntimeDependencies)) {
  if (pkg.dependencies?.[name] !== version) {
    throw new Error(`${name} must be an exact production dependency pinned to ${version}`);
  }
  if (pkg.devDependencies?.[name] != null) {
    throw new Error(`${name} must not be declared as a development-only dependency`);
  }
  if (lock.packages?.[""]?.dependencies?.[name] !== version) {
    throw new Error(`package-lock root must pin production dependency ${name} to ${version}`);
  }
  const locked = lock.packages?.[`node_modules/${name}`];
  if (locked?.version !== version || locked?.dev === true) {
    throw new Error(`package-lock package ${name} must resolve production version ${version}`);
  }
}

if (!existsSync(releaseNotesPath)) throw new Error(`release notes are missing: docs/releases/v${expected}.md`);
if (!readFileSync(releaseNotesPath, "utf8").trim()) throw new Error(`release notes are empty: docs/releases/v${expected}.md`);
for (const requiredFile of ["scripts/run-agent-task-benchmark.mjs", "docs/agent-task-benchmark.md", `docs/releases/v${expected}.md`]) {
  if (!pkg.files?.includes(requiredFile)) throw new Error(`published package files must include ${requiredFile}`);
}

if (pkg.mcpName !== server.name) throw new Error("package mcpName and server.json name differ");
if (manifest.tools_generated !== true) throw new Error("MCPB manifest must declare tools_generated");
const defaultCaps = "offline";
if (manifest.user_config?.capabilities?.default !== defaultCaps) throw new Error("MCPB default capabilities drifted");
if (server.packages?.[0]?.packageArguments?.[1]?.default !== defaultCaps) throw new Error("Registry default capabilities drifted");
if (manifest.user_config?.precision?.default !== "lsp") throw new Error("MCPB semantic precision must default to lsp");
if (manifest.server?.mcp_config?.env?.WEAVATRIX_PRECISION !== "${user_config.precision}") {
  throw new Error("MCPB semantic precision setting is not wired into the server environment");
}
if (manifest.server?.mcp_config?.env?.WEAVATRIX_ALLOW_TEST_RUNS !== "${user_config.allow_test_runs}") {
  throw new Error("MCPB verified_change test permission is not wired into the server environment");
}
if (manifest.user_config?.allow_test_runs?.default !== "0") {
  throw new Error("MCPB verified_change test execution must default to disabled");
}
const registryPrecision = server.packages?.[0]?.environmentVariables?.find(
  (entry) => entry?.name === "WEAVATRIX_PRECISION",
);
if (!registryPrecision || registryPrecision.isRequired !== false || registryPrecision.format !== "string") {
  throw new Error("server.json must expose optional WEAVATRIX_PRECISION for Registry installs");
}
const registryTestRuns = server.packages?.[0]?.environmentVariables?.find(
  (entry) => entry?.name === "WEAVATRIX_ALLOW_TEST_RUNS",
);
if (!registryTestRuns || registryTestRuns.isRequired !== false || registryTestRuns.format !== "string") {
  throw new Error("server.json must expose optional WEAVATRIX_ALLOW_TEST_RUNS for Registry installs");
}

const tag = process.env.GITHUB_REF_NAME;
if (process.env.GITHUB_REF_TYPE === "tag" && tag !== `v${expected}`) {
  throw new Error(`tag ${tag || "(missing)"} does not match package v${expected}`);
}

process.stdout.write(`Release metadata is consistent for ${expected}.\n`);
