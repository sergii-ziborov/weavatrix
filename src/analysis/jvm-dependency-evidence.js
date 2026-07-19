import { createRepoBoundary } from "../repo-path.js";
import { dependencyVerification, makeFinding } from "./findings.js";
import { parseGradleDependencies, parseGradleVersionCatalog, parseMavenPom } from "./jvm-manifests.js";
import { collectJvmArtifactIndex } from "./jvm-artifact-index.js";
import { listRepoFiles, readRepoText } from "./internal-audit.collect.js";

const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const javaBuiltin = (name) => /^(?:java|jdk|sun)\.|^(?:org\.w3c\.dom|org\.xml\.sax)(?:\.|$)/.test(name);

function mappingScore(spec, dependency) {
  const imported = String(spec || "").replace(/\.\*$/, "");
  if (!imported || !dependency.group) return 0;
  if (imported === dependency.group || imported.startsWith(`${dependency.group}.`)) return 1_000 + dependency.group.length;
  const compactImport = normalize(imported), compactArtifact = normalize(dependency.artifact);
  if (compactArtifact.length >= 4 && compactImport.includes(compactArtifact)) return 500 + compactArtifact.length;
  const artifactTokens = String(dependency.artifact).toLowerCase().split(/[-_.]+/).filter((part) => part.length >= 4 && !["core", "java", "client", "common", "api"].includes(part));
  const hits = artifactTokens.filter((part) => imported.toLowerCase().split(".").some((segment) => normalize(segment) === normalize(part))).length;
  return hits ? 100 + hits : 0;
}

function bestDependency(spec, dependencies) {
  const ranked = dependencies.map((dependency) => ({ dependency, score: mappingScore(spec, dependency) }))
    .filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.dependency.name.localeCompare(right.dependency.name));
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
  return ranked[0].dependency;
}

function analyze(ecosystem, manifests, dependencies, imports, unresolvedDeclarations, mappingDependencies = dependencies, includeMissing = true, artifactEvidence) {
  const findings = [], used = new Map(), missing = new Map();
  const owned = new Set(dependencies.map((dependency) => dependency.name));
  let exactMappedImports = 0, heuristicMappedImports = 0, ambiguousImports = 0;
  for (const item of imports) {
    const exactOwners = artifactEvidence.resolve(item.spec || item.pkg);
    if (exactOwners.length > 1) ambiguousImports++;
    const dependency = exactOwners.length === 1
      ? mappingDependencies.find((candidate) => candidate.name === exactOwners[0])
      : bestDependency(item.spec || item.pkg, mappingDependencies);
    if (dependency) {
      if (exactOwners.length === 1) exactMappedImports++; else heuristicMappedImports++;
      if (owned.has(dependency.name)) {
        const list = used.get(dependency.name) || [];
        list.push(item); used.set(dependency.name, list);
      }
    } else {
      const key = item.spec || item.pkg;
      const list = missing.get(key) || [];
      list.push(item); missing.set(key, list);
    }
  }
  const runtimeOnly = /runtime|provided|classpath|annotationProcessor|kapt/i;
  for (const dependency of dependencies) {
    const evidence = used.get(dependency.name) || [];
    if (evidence.length || dependency.optional || runtimeOnly.test(dependency.scope || "")) continue;
    findings.push(makeFinding({
      category: "unused", rule: "unused-dep", severity: "low", confidence: "low",
      title: `Unused ${ecosystem} dependency: ${dependency.name}`,
      reason: "No indexed Java import mapped to this declared artifact; reflection, service loading, generated code and runtime-only use remain possible.",
      detail: `"${dependency.name}" is declared in ${dependency.file}, but no indexed Java import maps to it. Review framework, reflection, ServiceLoader and generated-source use before removal.`,
      package: dependency.name, version: dependency.version, manifest: dependency.file, source: "internal",
      verification: dependencyVerification(dependency.file, [], "REVIEW_REQUIRED", "group-prefix/artifact-token"),
      fixHint: `remove ${dependency.name} only after the ${ecosystem} build and tests confirm it is unused`,
    }));
  }
  for (const [spec, evidence] of includeMissing ? missing : []) {
    if (javaBuiltin(spec)) continue;
    findings.push(makeFinding({
      category: "unused", rule: "missing-dep", severity: "medium", confidence: "medium",
      title: `Unmapped Java import: ${spec}`,
      reason: `The indexed Java import did not map to any declared ${ecosystem} artifact.`,
      detail: `"${spec}" is imported by ${evidence.length} file(s), but no ${ecosystem} declaration has a matching group prefix or artifact token. Add the owning artifact or configure/build the source that supplies it.`,
      package: spec, file: evidence[0].file, line: evidence[0].line || 0,
      evidence: evidence.slice(0, 5).map((item) => ({ file: item.file, line: item.line || 0, snippet: item.spec || "" })),
      source: "internal",
      verification: { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "ACTION_REQUIRED", manifestDeclaration: { status: "NOT_FOUND", files: manifests }, indexedSourceImports: { status: "FOUND", count: evidence.length, files: evidence.map((item) => item.file).slice(0, 10) }, mapping: "group-prefix/artifact-token" },
      fixHint: `identify the artifact that owns ${spec} and declare it in the nearest ${ecosystem} manifest`,
    }));
  }
  const present = manifests.length > 0;
  const exactComplete = present && unresolvedDeclarations === 0 && !artifactEvidence.truncated
    && artifactEvidence.errors.length === 0 && artifactEvidence.artifactsMissing === 0
    && artifactEvidence.artifactsIndexed === artifactEvidence.artifactsRequired
    && exactMappedImports === imports.length && ambiguousImports === 0;
  return {
    present,
    status: present ? "CHECKED" : "NOT_PRESENT",
    completeness: present ? (exactComplete ? "COMPLETE" : "PARTIAL") : "NOT_APPLICABLE",
    manifests,
    declared: dependencies.length,
    mappedImports: [...used.values()].reduce((sum, list) => sum + list.length, 0),
    unmappedImports: [...missing.values()].reduce((sum, list) => sum + list.length, 0),
    unresolvedDeclarations,
    exactArtifactEvidence: {
      artifactsRequired: artifactEvidence.artifactsRequired,
      artifactsIndexed: artifactEvidence.artifactsIndexed,
      artifactsMissing: artifactEvidence.artifactsMissing,
      classesIndexed: artifactEvidence.classCount,
      exactMappedImports,
      heuristicMappedImports,
      ambiguousImports,
      truncated: artifactEvidence.truncated,
      errors: artifactEvidence.errors.slice(0, 10),
    },
    sample: dependencies.slice(0, 20).map(({ file, name, version }) => ({ file, identity: name, version })),
    reason: !present
      ? `No ${ecosystem === "maven" ? "pom.xml" : "Gradle build file"} was discovered.`
      : exactComplete
        ? `${dependencies.length} declarations were compared with every indexed non-JDK Java import using exact class ownership from ${artifactEvidence.artifactsIndexed} installed JAR(s).`
        : `${dependencies.length} declarations and every indexed non-JDK Java import were checked, but exact artifact evidence is partial: ${unresolvedDeclarations} unresolved declaration(s), ${artifactEvidence.artifactsMissing} installed JAR(s) missing, ${heuristicMappedImports} heuristic mapping(s), ${ambiguousImports} ambiguous mapping(s). Heuristic missing/unused findings remain review evidence, never compiler proof.`,
    findings,
  };
}

export function collectJvmDependencyEvidence(repoRoot, { files = listRepoFiles(repoRoot), externalImports = [] } = {}) {
  const boundary = createRepoBoundary(repoRoot);
  const mavenFiles = files.filter((file) => /(^|\/)pom\.xml$/i.test(file));
  const gradleFiles = files.filter((file) => /(^|\/)(?:build|settings|[^/]+)\.gradle(?:\.kts)?$/i.test(file));
  const catalogFiles = files.filter((file) => /(^|\/)libs\.versions\.toml$/i.test(file));
  const catalog = new Map();
  for (const file of catalogFiles) for (const [alias, entry] of parseGradleVersionCatalog(readRepoText(boundary, file))) catalog.set(alias, entry);
  let mavenUnresolved = 0, gradleUnresolved = 0;
  const mavenDependencies = mavenFiles.flatMap((file) => {
    const parsed = parseMavenPom(readRepoText(boundary, file));
    mavenUnresolved += parsed.unresolvedDeclarations;
    return parsed.dependencies.map((dependency) => ({ ...dependency, file }));
  });
  const gradleDependencies = gradleFiles.flatMap((file) => {
    const parsed = parseGradleDependencies(readRepoText(boundary, file), catalog);
    gradleUnresolved += parsed.unresolvedDeclarations || 0;
    return parsed.map((dependency) => ({ ...dependency, file }));
  });
  const javaImports = externalImports.filter((entry) => entry.ecosystem === "Maven" && entry.pkg && !entry.builtin && !entry.unresolved);
  const allDependencies = [...mavenDependencies, ...gradleDependencies];
  const artifactEvidence = collectJvmArtifactIndex(allDependencies);
  return {
    maven: analyze("maven", mavenFiles, mavenDependencies, javaImports, mavenUnresolved, allDependencies, true, artifactEvidence),
    gradle: analyze("gradle", [...gradleFiles, ...catalogFiles], gradleDependencies, javaImports, gradleUnresolved, allDependencies, mavenFiles.length === 0, artifactEvidence),
  };
}
