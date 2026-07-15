// Repo listing: describe direct child git repos of a folder and browse child folders.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../config.js";
import { repoFileCount, repoInventory, repoLastCommit } from "./discover.inventory.js";
import { detectFramework, detectRepoStack } from "./discover.stack.js";

function reposDefaultFolder() {
  return join(ROOT_DIR, "..", "..");
}

function describeRepo(dir, name) {
  const has = (file) => existsSync(join(dir, file));
  // RUNTIME first — a Bun/Deno project also has a package.json, so check its markers before falling
  // back to "node". (Fixes Bun repos like edge-analytics being mislabelled "node".)
  let language = "other";
  if (has("bun.lock") || has("bun.lockb") || has("bunfig.toml")) language = "bun";
  else if (has("deno.json") || has("deno.jsonc") || has("deno.lock")) language = "deno";
  else if (has("package.json")) language = "node";
  else if (has("go.mod")) language = "go";
  else if (has("pom.xml") || has("build.gradle")) language = "java";
  else if (has("requirements.txt") || has("pyproject.toml") || has("setup.py") || has("Pipfile")) language = "python";
  else if (has("Cargo.toml")) language = "rust";
  else if (has("composer.json")) language = "php";
  else if (has("Gemfile")) language = "ruby";
  // framework detection uses the JS-ecosystem table for bun/deno too (they run npm packages)
  const fwRuntime = language === "bun" || language === "deno" ? "node" : language;
  const inventory = repoInventory(dir);
  const stack = detectRepoStack(dir, inventory);
  language = stack.languages[0]?.id || stack.runtimes[0]?.id || language;
  const stackRunsJs = stack.runtimes.some((badge) => ["node", "bun", "deno"].includes(badge.id)) || ["javascript", "typescript"].includes(language);
  const stackFwRuntime = stackRunsJs ? "node" : language;
  return {
    name,
    path: dir,
    language,
    stack,
    framework: detectFramework(dir, stackFwRuntime || fwRuntime),
    knipEligible: has("package.json"),
    size: inventory.count || repoFileCount(dir),
    lastCommit: repoLastCommit(dir)
  };
}

// Only DIRECT child git repos of the opened folder. We do not descend into folders or into
// repos, so nested/sub-repos are not listed.
export function listGitRepos(folder) {
  const root = folder && String(folder).trim() ? String(folder).trim() : reposDefaultFolder();
  if (!existsSync(root)) throw new Error(`Folder not found: ${root}`);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read folder: ${error.message}`);
  }
  const repos = entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ".git")))
    .map((entry) => describeRepo(join(root, entry.name), entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { root, repos };
}

export function repoBaseName(repoPath) {
  return String(repoPath).split(/[\\/]/).filter(Boolean).pop() || repoPath;
}

export function listChildFolders(folder) {
  const root = folder && existsSync(folder) ? folder : reposDefaultFolder();
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => ({
      name: entry.name,
      path: join(root, entry.name),
      isRepo: existsSync(join(root, entry.name, ".git"))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = join(root, "..");
  return { path: root, parent: parent !== root ? parent : null, entries };
}
