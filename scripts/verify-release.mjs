import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const manifest = readJson("mcpb/manifest.json");
const server = readJson("server.json");
const expected = pkg.version;
const releaseNotesPath = resolve("docs", "releases", `v${expected}.md`);

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

if (!existsSync(releaseNotesPath)) throw new Error(`release notes are missing: docs/releases/v${expected}.md`);
if (!readFileSync(releaseNotesPath, "utf8").trim()) throw new Error(`release notes are empty: docs/releases/v${expected}.md`);

if (pkg.mcpName !== server.name) throw new Error("package mcpName and server.json name differ");
if (manifest.tools_generated !== true) throw new Error("MCPB manifest must declare tools_generated");
const defaultCaps = "offline";
if (manifest.user_config?.capabilities?.default !== defaultCaps) throw new Error("MCPB default capabilities drifted");
if (server.packages?.[0]?.packageArguments?.[1]?.default !== defaultCaps) throw new Error("Registry default capabilities drifted");

const tag = process.env.GITHUB_REF_NAME;
if (process.env.GITHUB_REF_TYPE === "tag" && tag !== `v${expected}`) {
  throw new Error(`tag ${tag || "(missing)"} does not match package v${expected}`);
}

process.stdout.write(`Release metadata is consistent for ${expected}.\n`);
