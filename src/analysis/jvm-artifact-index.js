import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const concreteVersion = (value) => !!value && !/[\[\](),${}*+]/.test(String(value));
const safeEntries = (path) => { try { return readdirSync(path, { withFileTypes: true }); } catch { return []; } };

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

// JARs are ZIP files. Reading only the central directory avoids extraction and code execution.
export function readJarClassNames(path, { maxClasses = 250_000 } = {}) {
  const buffer = readFileSync(path);
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error("ZIP central directory is missing");
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const classes = new Set(), packages = new Set();
  let truncated = false;
  for (let index = 0; index < entries && offset + 46 <= buffer.length; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid ZIP central directory entry");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    name = name.replace(/^META-INF\/versions\/\d+\//, "");
    if (!name.endsWith(".class") || /(?:^|\/)(?:module-info|package-info)\.class$/.test(name)) continue;
    const identity = name.slice(0, -6).replace(/\$/g, ".").replace(/\//g, ".");
    classes.add(identity);
    packages.add(identity.includes(".") ? identity.slice(0, identity.lastIndexOf(".")) : "");
    if (classes.size >= maxClasses) { truncated = true; break; }
  }
  return { classes, packages, truncated };
}

function artifactCandidates(dependency, home) {
  if (!dependency.group || !dependency.artifact || !concreteVersion(dependency.version)) return [];
  const file = `${dependency.artifact}-${dependency.version}.jar`;
  const maven = join(home, ".m2", "repository", ...dependency.group.split("."), dependency.artifact, dependency.version, file);
  const gradleRoot = join(home, ".gradle", "caches", "modules-2", "files-2.1", dependency.group, dependency.artifact, dependency.version);
  const gradle = safeEntries(gradleRoot).filter((entry) => entry.isDirectory()).flatMap((entry) =>
    safeEntries(join(gradleRoot, entry.name)).filter((child) => child.isFile() && child.name.endsWith(".jar"))
      .map((child) => join(gradleRoot, entry.name, child.name)));
  return [maven, ...gradle].filter((candidate, index, all) => existsSync(candidate) && all.indexOf(candidate) === index);
}

const addOwner = (map, key, owner) => {
  const owners = map.get(key) || new Set();
  owners.add(owner); map.set(key, owners);
};

// Exact import -> artifact evidence from already-installed Maven/Gradle JARs. This is offline and
// read-only: no build tool, plugin, class loader or repository code is executed.
export function collectJvmArtifactIndex(dependencies, { home = homedir(), maxArtifacts = 256, maxClasses = 500_000 } = {}) {
  const unique = [...new Map(dependencies.map((dependency) => [dependency.name, dependency])).values()];
  const classes = new Map(), packages = new Map(), errors = [];
  let artifactsIndexed = 0, artifactsMissing = 0, classCount = 0, truncated = false;
  for (const dependency of unique) {
    if (artifactsIndexed >= maxArtifacts || classCount >= maxClasses) { truncated = true; break; }
    const candidates = artifactCandidates(dependency, home);
    if (!candidates.length) { artifactsMissing++; continue; }
    try {
      const remaining = Math.max(1, maxClasses - classCount);
      const content = readJarClassNames(candidates[0], { maxClasses: remaining });
      for (const identity of content.classes) addOwner(classes, identity, dependency.name);
      for (const identity of content.packages) addOwner(packages, identity, dependency.name);
      classCount += content.classes.size; artifactsIndexed++; truncated ||= content.truncated;
    } catch (error) {
      errors.push(`${dependency.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const resolve = (spec) => {
    const imported = String(spec || "").replace(/\.\*$/, "");
    const owners = String(spec || "").endsWith(".*") ? packages.get(imported) : classes.get(imported);
    return [...(owners || [])].sort();
  };
  return {
    resolve, artifactsRequired: unique.length, artifactsIndexed, artifactsMissing,
    classCount, errors, truncated,
  };
}
