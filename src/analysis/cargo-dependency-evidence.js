import { createRepoBoundary } from "../repo-path.js";
import { cargoName, parseCargoToml } from "./cargo-manifests.js";
import { dependencyVerification, makeFinding } from "./findings.js";
import { listRepoFiles, readRepoText } from "./internal-audit.collect.js";
import { dependencyScopeOwnsFile, dependencyScopeRoot } from "./dependency/scoped-dependencies.js";

export function collectCargoDependencyEvidence(repoRoot, { files = listRepoFiles(repoRoot), externalImports = [] } = {}) {
  const boundary = createRepoBoundary(repoRoot);
  const manifests = files.filter((file) => /(^|\/)Cargo\.toml$/i.test(file));
  const scopes = manifests.map((file) => ({ file, root: dependencyScopeRoot(file), ...parseCargoToml(readRepoText(boundary, file)) }))
    .sort((left, right) => right.root.length - left.root.length || left.root.localeCompare(right.root));
  const workspaceDeps = new Map();
  for (const scope of scopes) for (const dependency of scope.workspaceDependencies) workspaceDeps.set(cargoName(dependency.alias), dependency);
  const issues = [];
  for (const scope of scopes) {
    scope.dependencies = scope.dependencies.map((dependency) => {
      if (!dependency.inherited) return dependency;
      const inherited = workspaceDeps.get(cargoName(dependency.alias));
      if (!inherited) { issues.push(`${scope.file}: workspace dependency ${dependency.alias} is unresolved`); return dependency; }
      return { ...dependency, name: inherited.name, version: inherited.version, inherited: true };
    });
  }
  const importsByScope = new Map(scopes.map((scope) => [scope, []]));
  for (const entry of externalImports) {
    if (entry.ecosystem !== "crates.io" || !entry.pkg || entry.builtin || entry.unresolved) continue;
    const owner = scopes.find((scope) => dependencyScopeOwnsFile(scope.root, entry.file));
    if (owner) importsByScope.get(owner).push(entry);
  }
  const findings = [], declared = new Set();
  let mappedImports = 0, unmappedImports = 0;
  if (!scopes.length) {
    const missing = new Map();
    for (const entry of externalImports.filter((item) => item.ecosystem === "crates.io" && item.pkg && !item.builtin && !item.unresolved)) {
      if (!missing.has(cargoName(entry.pkg))) missing.set(cargoName(entry.pkg), entry);
    }
    for (const [name, entry] of missing) findings.push(makeFinding({
      category: "unused", rule: "missing-dep", severity: "low", confidence: "high",
      title: `Rust crate path without Cargo.toml: ${name}`,
      reason: "An indexed external Rust crate path exists, but no Cargo.toml was discovered.",
      detail: `"${entry.spec || name}" is used by ${entry.file}, but no Cargo manifest owns the file.`,
      package: name, file: entry.file, line: entry.line || 0, source: "internal",
      verification: { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "ACTION_REQUIRED", manifestDeclaration: { status: "NOT_PRESENT" }, indexedSourceImports: { status: "FOUND", count: 1, files: [entry.file] }, mapping: "Cargo crate name normalization" },
      fixHint: "initialize or restore the owning Cargo manifest",
    }));
  }
  for (const scope of scopes) {
    const imports = importsByScope.get(scope);
    const used = new Map(), missingSeen = new Set();
    for (const entry of imports) {
      const imported = cargoName(entry.pkg);
      // A crate referencing its own package name (routine in examples/, tests/, benches/ and the
      // [[bin]] that pairs with a [lib]) is a self-reference, never a missing dependency.
      if (scope.packageName && imported === cargoName(scope.packageName)) { mappedImports++; continue; }
      const dependency = scope.dependencies.find((item) => cargoName(item.alias) === imported || cargoName(item.name) === imported);
      if (dependency) {
        const evidence = used.get(dependency.alias) || [];
        evidence.push(entry); used.set(dependency.alias, evidence); mappedImports++;
        continue;
      }
      unmappedImports++;
      if (missingSeen.has(imported)) continue;
      missingSeen.add(imported);
      findings.push(makeFinding({
        category: "unused", rule: "missing-dep", severity: "medium", confidence: "high",
        title: `Missing Cargo dependency: ${entry.pkg}`,
        reason: "An indexed external Rust crate path has no matching dependency alias or package name in the nearest Cargo.toml.",
        detail: `"${entry.spec || entry.pkg}" is used by ${entry.file}, but ${scope.file} does not declare crate "${entry.pkg}" (including workspace inheritance and renamed packages).`,
        package: entry.pkg, file: entry.file, line: entry.line || 0, manifest: scope.file,
        evidence: [{ file: entry.file, line: entry.line || 0, snippet: entry.spec || "" }], source: "internal",
        verification: { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "ACTION_REQUIRED", manifestDeclaration: { status: "NOT_FOUND", file: scope.file }, indexedSourceImports: { status: "FOUND", count: 1, files: [entry.file] }, mapping: "Cargo alias/package normalization" },
        fixHint: `cargo add ${entry.pkg}`,
      }));
    }
    for (const dependency of scope.dependencies) {
      const identity = cargoName(dependency.name);
      if (!identity) continue;
      declared.add(`${scope.root || "."}:${identity}`);
      const evidence = used.get(dependency.alias) || [];
      if (evidence.length || dependency.optional || dependency.build) continue;
      findings.push(makeFinding({
        category: "unused", rule: "unused-dep", severity: dependency.dev ? "info" : "low", confidence: "low",
        title: `Unused Cargo dependency: ${dependency.name}`,
        reason: "No indexed Rust use/path/extern-crate evidence maps to this dependency; feature-only, proc-macro, generated and reflective registration remain possible.",
        detail: `"${dependency.name}" (${dependency.alias}) is declared in ${scope.file}, but no indexed .rs file in that Cargo scope references its crate path. Confirm with cargo check/test and feature combinations before removal.`,
        package: dependency.name, version: dependency.version, manifest: scope.file, source: "internal",
        verification: dependencyVerification(scope.file, [], "REVIEW_REQUIRED", "Cargo alias/package normalization"),
        fixHint: `cargo remove ${dependency.alias} after checking all features and targets`,
      }));
    }
  }
  const present = manifests.length > 0;
  return {
    present,
    status: present ? "CHECKED" : "NOT_PRESENT",
    completeness: present ? (issues.length ? "PARTIAL" : "COMPLETE") : "NOT_APPLICABLE",
    manifests,
    declared,
    mappedImports,
    unmappedImports,
    findings,
    reasons: issues,
    reason: !present
      ? "No Cargo.toml was discovered."
      : issues.length
        ? `Cargo declarations and indexed crate paths were checked, but ${issues.length} workspace inheritance reference(s) remain unresolved.`
        : `Cargo declarations from ${manifests.length} scope(s), workspace inheritance, renamed packages and every indexed external crate path were compared.`,
  };
}
