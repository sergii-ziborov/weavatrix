import { createRepoBoundary } from "../repo-path.js";
import { listRepoFiles, readRepoText } from "../analysis/internal-audit/repo-files.js";
import { parseCargoLockPackages } from "../analysis/cargo-manifests.js";
import { parseGradleDependencies, parseGradleLockPackages, parseGradleVersionCatalog, parseMavenPom } from "../analysis/jvm-manifests.js";

const dedupe = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.ecosystem}|${item.name}|${item.version}`;
    if (!item.name || !item.version || seen.has(key)) return false;
    seen.add(key); return true;
  });
};
const concreteVersion = (value) => !!value && !/[\[\](),${}*+]/.test(String(value));

export function collectJvmRustInstalled(repoPath) {
  const boundary = createRepoBoundary(repoPath);
  if (!boundary.root) return [];
  const files = listRepoFiles(repoPath);
  const installed = [];
  for (const file of files.filter((name) => /(^|\/)Cargo\.lock$/i.test(name))) {
    installed.push(...parseCargoLockPackages(readRepoText(boundary, file)));
  }
  for (const file of files.filter((name) => /(^|\/)pom\.xml$/i.test(name))) {
    const parsed = parseMavenPom(readRepoText(boundary, file));
    installed.push(...parsed.dependencies.filter((item) => concreteVersion(item.version)).map((item) => ({
      ecosystem: "Maven", name: item.name, version: item.version, dev: item.scope === "test",
      integrity: "", source: "pom",
    })));
  }
  const catalog = new Map();
  for (const file of files.filter((name) => /(^|\/)libs\.versions\.toml$/i.test(name))) {
    for (const [alias, entry] of parseGradleVersionCatalog(readRepoText(boundary, file))) catalog.set(alias, entry);
  }
  for (const file of files.filter((name) => /(^|\/)(?:build|settings|[^/]+)\.gradle(?:\.kts)?$/i.test(name))) {
    const dependencies = parseGradleDependencies(readRepoText(boundary, file), catalog);
    installed.push(...dependencies.filter((item) => concreteVersion(item.version)).map((item) => ({
      ecosystem: "Maven", name: item.name, version: item.version,
      dev: /test/i.test(item.scope || ""), integrity: "", source: "gradle-manifest",
    })));
  }
  for (const file of files.filter((name) => /(^|\/)(?:gradle\.lockfile|dependency-locks\/[^/]+\.lockfile)$/i.test(name))) {
    installed.push(...parseGradleLockPackages(readRepoText(boundary, file)));
  }
  return dedupe(installed);
}
