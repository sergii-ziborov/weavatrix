// Maven/Gradle manifest presence and bounded declaration counts. We intentionally do not map Java
// imports to artifacts: package-to-artifact resolution needs a real build model and claiming 0/0 from
// source regexes would be worse than an explicit NOT_SUPPORTED/PARTIAL state.
import { createRepoBoundary } from "../repo-path.js";
import { listRepoFiles, readRepoText } from "./internal-audit.collect.js";

function mavenDeclarations(text) {
  const source = String(text || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<dependencyManagement\b[\s\S]*?<\/dependencyManagement>/gi, " ");
  const identities = [];
  const re = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi;
  let match;
  while ((match = re.exec(source))) {
    const group = /<groupId>\s*([^<]+?)\s*<\/groupId>/i.exec(match[1])?.[1]?.trim() || "";
    const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/i.exec(match[1])?.[1]?.trim() || "";
    if (artifact) identities.push(group ? `${group}:${artifact}` : artifact);
  }
  return identities;
}

function gradleDeclarations(text) {
  const source = String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  const declarations = [];
  const configurations = "api|implementation|compileOnly|runtimeOnly|annotationProcessor|kapt|testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation";
  const line = new RegExp(`^\\s*(?:${configurations})\\s*(?:\\(\\s*)?([^\\r\\n]+)`, "gmi");
  let match;
  while ((match = line.exec(source))) {
    const expression = match[1].trim().replace(/[),;]+\s*$/, "");
    const coordinate = /["']([^"']+:[^"']+)["']/.exec(expression)?.[1] || "";
    const catalog = /\blibs(?:\.[A-Za-z_]\w*)+/.exec(expression)?.[0] || "";
    declarations.push(coordinate || catalog || "unresolved-declaration");
  }
  return declarations;
}

export function collectJvmDependencyEvidence(repoRoot, { files = listRepoFiles(repoRoot) } = {}) {
  const boundary = createRepoBoundary(repoRoot);
  const mavenFiles = files.filter((file) => /(^|\/)pom\.xml$/i.test(file));
  const gradleFiles = files.filter((file) => /(^|\/)build\.gradle(?:\.kts)?$/i.test(file));
  const maven = mavenFiles.flatMap((file) => mavenDeclarations(readRepoText(boundary, file)).map((identity) => ({ file, identity })));
  const gradle = gradleFiles.flatMap((file) => gradleDeclarations(readRepoText(boundary, file)).map((identity) => ({ file, identity })));
  return {
    maven: {
      present: mavenFiles.length > 0,
      status: mavenFiles.length ? "NOT_SUPPORTED" : "NOT_PRESENT",
      completeness: mavenFiles.length ? "PARTIAL" : "NOT_APPLICABLE",
      manifests: mavenFiles,
      declared: maven.length,
      sample: maven.slice(0, 20),
      reason: mavenFiles.length
        ? "Maven manifests and declaration counts were detected, but Java package imports were not mapped to Maven artifacts; unused/missing dependency verdicts are not supported."
        : "No pom.xml was discovered.",
    },
    gradle: {
      present: gradleFiles.length > 0,
      status: gradleFiles.length ? "NOT_SUPPORTED" : "NOT_PRESENT",
      completeness: gradleFiles.length ? "PARTIAL" : "NOT_APPLICABLE",
      manifests: gradleFiles,
      declared: gradle.length,
      sample: gradle.slice(0, 20),
      reason: gradleFiles.length
        ? "Gradle manifests and bounded dependency declarations were detected, but version catalogs/build logic and Java package-to-artifact mapping were not resolved; unused/missing dependency verdicts are not supported."
        : "No build.gradle/build.gradle.kts was discovered.",
    },
  };
}
