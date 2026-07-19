import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCargoLockPackages, parseCargoToml } from "../src/analysis/cargo-manifests.js";
import { parseGradleDependencies, parseGradleLockPackages, parseGradleVersionCatalog, parseMavenPom } from "../src/analysis/jvm-manifests.js";
import { collectInstalled } from "../src/security/installed.js";

test("Cargo manifests resolve renamed/workspace declarations and Cargo.lock yields crates.io pins", () => {
  const manifest = parseCargoToml(`
[package]
name = "service"
[dependencies]
serde = "1.0.210"
async_runtime = { package = "tokio", workspace = true }
[target.'cfg(unix)'.dependencies]
nix = { version = "0.29.0", optional = true }
[workspace.dependencies]
async_runtime = { package = "tokio", version = "1.40.0" }
`);
  assert.equal(manifest.packageName, "service");
  assert.deepEqual(manifest.dependencies.map((item) => [item.alias, item.name, item.version, item.inherited]), [
    ["serde", "serde", "1.0.210", false],
    ["async_runtime", "tokio", "", true],
    ["nix", "nix", "0.29.0", false],
  ]);
  assert.deepEqual(manifest.workspaceDependencies.map((item) => [item.alias, item.name, item.version]), [["async_runtime", "tokio", "1.40.0"]]);
  const locked = parseCargoLockPackages(`
version = 4
[[package]]
name = "serde"
version = "1.0.210"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"
[[package]]
name = "service"
version = "0.1.0"
`);
  assert.deepEqual(locked.map((item) => [item.ecosystem, item.name, item.version]), [["crates.io", "serde", "1.0.210"]]);
});

test("Maven properties and Gradle version catalogs/locks resolve concrete artifact evidence", () => {
  const pom = parseMavenPom(`<project><properties><slf4j.version>2.0.13</slf4j.version></properties><dependencies>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>\${slf4j.version}</version></dependency>
  </dependencies></project>`);
  assert.deepEqual(pom.dependencies.map((item) => [item.name, item.version]), [["org.slf4j:slf4j-api", "2.0.13"]]);
  const catalog = parseGradleVersionCatalog(`[versions]\njackson = "2.17.2"\n[libraries]\njackson-databind = { module = "com.fasterxml.jackson.core:jackson-databind", version.ref = "jackson" }`);
  const gradle = parseGradleDependencies(`dependencies {\n implementation(libs.jackson.databind)\n implementation("org.slf4j:slf4j-api:2.0.13")\n}`, catalog);
  assert.deepEqual(gradle.map((item) => [item.name, item.version]), [
    ["com.fasterxml.jackson.core:jackson-databind", "2.17.2"],
    ["org.slf4j:slf4j-api", "2.0.13"],
  ]);
  assert.deepEqual(parseGradleLockPackages("org.slf4j:slf4j-api:2.0.13=runtimeClasspath\n").map((item) => item.name), ["org.slf4j:slf4j-api"]);
});

test("collectInstalled scans deeply nested Cargo, Maven, Gradle, Python, and Go package evidence", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-multilang-installed-"));
  const write = (file, value) => { const path = join(repo, file); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, value); };
  try {
    mkdirSync(join(repo, ".git"));
    write("services/deep/rust/Cargo.lock", `[[package]]\nname = "serde"\nversion = "1.0.210"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`);
    write("services/deep/java/pom.xml", `<project><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version></dependency></dependencies></project>`);
    write("services/deep/gradle/gradle.lockfile", "com.fasterxml.jackson.core:jackson-databind:2.17.2=runtimeClasspath\n");
    write("services/deep/python/requirements.txt", "requests==2.32.3\n");
    write("services/deep/go/go.mod", "module example.test/service\nrequire golang.org/x/net v0.28.0\n");
    const keys = collectInstalled(repo).installed.map((item) => `${item.ecosystem}:${item.name}@${item.version}`);
    for (const expected of [
      "crates.io:serde@1.0.210", "Maven:org.slf4j:slf4j-api@2.0.13",
      "Maven:com.fasterxml.jackson.core:jackson-databind@2.17.2", "PyPI:requests@2.32.3", "Go:golang.org/x/net@0.28.0",
    ]) assert.ok(keys.includes(expected), expected);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
