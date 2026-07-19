const stripComments = (value) => String(value || "").replace(/<!--[\s\S]*?-->/g, " ");
const clean = (value) => String(value || "").trim().replace(/^['"]|['"]$/g, "");

function xmlValue(body, name) {
  return new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i").exec(body)?.[1]?.trim() || "";
}

function resolveMavenValue(value, properties) {
  let output = String(value || "");
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    output = output.replace(/\$\{([^}]+)}/g, (whole, key) => {
      if (!properties.has(key)) return whole;
      changed = true;
      return properties.get(key);
    });
    if (!changed) break;
  }
  return /\$\{/.test(output) ? "" : output.trim();
}

export function parseMavenPom(text) {
  const source = stripComments(text);
  const properties = new Map();
  const propertyBlock = /<properties\b[^>]*>([\s\S]*?)<\/properties>/i.exec(source)?.[1] || "";
  for (const match of propertyBlock.matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]+?)\s*<\/\1>/g)) properties.set(match[1], match[2].trim());
  const parent = /<parent\b[^>]*>([\s\S]*?)<\/parent>/i.exec(source)?.[1] || "";
  const beforeDependencies = source.split(/<dependencies\b/i)[0];
  const projectVersion = xmlValue(beforeDependencies, "version") || xmlValue(parent, "version");
  const projectGroup = xmlValue(beforeDependencies, "groupId") || xmlValue(parent, "groupId");
  properties.set("project.version", projectVersion); properties.set("pom.version", projectVersion);
  properties.set("project.groupId", projectGroup); properties.set("pom.groupId", projectGroup);
  const managed = new Map();
  for (const block of source.matchAll(/<dependencyManagement\b[^>]*>([\s\S]*?)<\/dependencyManagement>/gi)) {
    for (const dep of block[1].matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
      const group = resolveMavenValue(xmlValue(dep[1], "groupId"), properties);
      const artifact = resolveMavenValue(xmlValue(dep[1], "artifactId"), properties);
      const version = resolveMavenValue(xmlValue(dep[1], "version"), properties);
      if (group && artifact && version) managed.set(`${group}:${artifact}`, version);
    }
  }
  const directSource = source.replace(/<dependencyManagement\b[^>]*>[\s\S]*?<\/dependencyManagement>/gi, " ");
  const dependencies = [];
  const directBlocks = [...directSource.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)];
  for (const match of directBlocks) {
    const group = resolveMavenValue(xmlValue(match[1], "groupId"), properties);
    const artifact = resolveMavenValue(xmlValue(match[1], "artifactId"), properties);
    if (!group || !artifact) continue;
    dependencies.push({
      group, artifact, name: `${group}:${artifact}`,
      version: resolveMavenValue(xmlValue(match[1], "version"), properties) || managed.get(`${group}:${artifact}`) || "",
      scope: xmlValue(match[1], "scope") || "compile",
      optional: xmlValue(match[1], "optional") === "true",
    });
  }
  return { projectGroup, projectVersion, dependencies, unresolvedDeclarations: directBlocks.length - dependencies.length };
}

export function parseGradleVersionCatalog(text) {
  const versions = new Map(), libraries = new Map();
  let section = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    const header = /^\[([^\]]+)]$/.exec(line);
    if (header) { section = header[1]; continue; }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (section === "versions") { versions.set(kv[1], clean(kv[2])); continue; }
    if (section !== "libraries") continue;
    const alias = kv[1], value = kv[2];
    const module = /\bmodule\s*=\s*["']([^"']+)["']/.exec(value)?.[1]
      || /\bgroup\s*=\s*["']([^"']+)["'][\s\S]*?\bname\s*=\s*["']([^"']+)["']/.exec(value)?.slice(1, 3).join(":")
      || (/^["'][^"']+:[^"']+["']$/.test(value) ? clean(value) : "");
    if (!module) continue;
    const explicit = /\bversion\s*=\s*["']([^"']+)["']/.exec(value)?.[1] || "";
    const reference = /\bversion\.ref\s*=\s*["']([^"']+)["']/.exec(value)?.[1] || "";
    libraries.set(alias.replace(/[_.]/g, "-"), { module, version: explicit || versions.get(reference) || "" });
  }
  return libraries;
}

export function parseGradleDependencies(text, catalog = new Map()) {
  const source = String(text || "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1");
  const dependencies = [];
  const configurations = "api|implementation|compile|compileOnly|runtimeOnly|annotationProcessor|kapt|classpath|testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation";
  const matcher = new RegExp(`^\\s*(${configurations})\\s*(?:\\(\\s*)?([^\\r\\n]+)`, "gmi");
  const declarations = [...source.matchAll(matcher)];
  for (const match of declarations) {
    const expression = match[2].trim().replace(/[),;]+\s*$/, "");
    const coordinate = /["']([^"']+:[^"']+)["']/.exec(expression)?.[1] || "";
    if (coordinate) {
      const [group, artifact, version = ""] = coordinate.split(":");
      if (group && artifact) dependencies.push({ group, artifact, name: `${group}:${artifact}`, version, scope: match[1] });
      continue;
    }
    const alias = /\blibs((?:\.[A-Za-z_]\w*)+)/.exec(expression)?.[1]?.slice(1).replace(/\./g, "-") || "";
    const entry = catalog.get(alias);
    if (entry) {
      const [group, artifact] = entry.module.split(":");
      dependencies.push({ group, artifact, name: entry.module, version: entry.version, scope: match[1], catalogAlias: alias });
    }
  }
  dependencies.unresolvedDeclarations = declarations.length - dependencies.length;
  return dependencies;
}

export function parseGradleLockPackages(text) {
  const packages = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const match = /^([^#=\s:]+(?:\.[^#=\s:]+)*):([^#=\s:]+):([^#=\s=]+)=/.exec(raw.trim());
    if (match) packages.push({ ecosystem: "Maven", name: `${match[1]}:${match[2]}`, version: match[3], dev: false, integrity: "", source: "gradle-lock" });
  }
  return packages;
}
