import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInternalAudit } from "../src/analysis/internal-audit.js";
import { formatOrdinaryAudit } from "../src/mcp/health/audit-format.mjs";

test("internal audit leaves dependency health NOT_CHECKED when no manifest ecosystem was discovered", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-no-deps-"));
  try {
    writeFileSync(join(repo, "README.md"), "fixture without a dependency manifest\n");
    const audit = await runInternalAudit(repo, {
      graph: { nodes: [], links: [], externalImports: [] },
      advisoryStorePath: join(repo, "missing-advisories.json"),
      skipMalwareScan: true,
    });

    assert.equal(audit.dependencyReport.status, "NOT_CHECKED");
    assert.deepEqual(audit.dependencyReport.verificationCoverage, {});
    assert.match(audit.dependencyReport.reason, /verification did not run/);
    assert.equal(audit.healthCapabilities.dependencies.status, "NOT_CHECKED");
    const text = formatOrdinaryAudit(audit, {});
    assert.match(text, /Dependency manifests: NOT_CHECKED/);
    assert.match(text, /no dependency verdict was produced/);
    assert.doesNotMatch(text, /checked 0 declared package/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("internal audit reports NOT_CHECKED states and honors managed Python runtime config", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-run-"));
  try {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "runtime.py"), "import numpy\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { runtime: "python scripts/runtime.py" } }));
    writeFileSync(join(repo, ".weavatrix-deps.json"), JSON.stringify({ python: { managedDependencies: ["numpy"] } }));
    const graph = {
      nodes: [{ id: "scripts/runtime.py", source_file: "scripts/runtime.py", file_type: "code" }],
      links: [],
      externalImports: [{ file: "scripts/runtime.py", spec: "numpy", pkg: "numpy", ecosystem: "PyPI", kind: "py-import", line: 1 }],
    };
    const audit = await runInternalAudit(repo, { graph, advisoryStorePath: join(repo, "missing-advisories.json"), skipMalwareScan: true });
    assert.equal(audit.ok, true);
    assert.equal(audit.checks.osv.status, "NOT_CHECKED");
    assert.equal(audit.checks.malware.status, "NOT_CHECKED");
    assert.equal(audit.scanned.managedPythonDependencies, 1);
    assert.equal(audit.dependencyReport.status, "COMPLETE");
    assert.equal(audit.dependencyReport.importRecords, 1);
    assert.equal(audit.dependencyReport.unused, 0);
    assert.equal(audit.dependencyReport.missing, 0);
    assert.ok(!audit.findings.some((f) => f.rule === "missing-dep" && f.package === "numpy"));
    assert.equal(audit.healthCapabilities.structure.status, "CHECKED");
    assert.equal(audit.healthCapabilities.dependencies.status, "CHECKED");
    assert.equal(audit.healthCapabilities.dependencies.completeness, "COMPLETE");
    assert.equal(audit.healthCapabilities.runtimeCorrectness.status, "CHECKED");
    assert.equal(audit.healthCapabilities.concurrency.status, "NOT_SUPPORTED");
    assert.equal(audit.healthCapabilities.advisories.status, "NOT_CHECKED");
    assert.equal(audit.healthCapabilities.malware.status, "NOT_CHECKED");
    assert.equal(audit.healthCapabilities.coverage.status, "NOT_CHECKED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("internal audit preserves PARTIAL OSV coverage and distrusts a legacy global-only stamp", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-osv-state-"));
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
    const graph = { nodes: [], links: [], externalImports: [] };
    const partialPath = join(repo, "partial.json");
    const now = new Date().toISOString();
    writeFileSync(partialPath, JSON.stringify({
      meta: { fetched_at: now, repos: { [repo]: { fetched_at: now, status: "PARTIAL", queried: 4, queried_ok: 3, error_count: 1 } } },
      records: {},
    }));
    const partial = await runInternalAudit(repo, { graph, advisoryStorePath: partialPath, skipMalwareScan: true });
    assert.equal(partial.checks.osv.status, "PARTIAL");
    assert.match(partial.checks.osv.detail, /3\/4/);

    const staleOkPath = join(repo, "stale-ok.json");
    writeFileSync(staleOkPath, JSON.stringify({
      meta: { fetched_at: now, repos: { [repo]: { fetched_at: now, status: "OK", queried: 0, queried_ok: 0, query_fingerprint: "stale" } } },
      records: {},
    }));
    const staleOk = await runInternalAudit(repo, { graph, advisoryStorePath: staleOkPath, skipMalwareScan: true });
    assert.equal(staleOk.checks.osv.status, "PARTIAL");
    assert.match(staleOk.checks.osv.detail, /Dependency versions changed/);

    const legacyPath = join(repo, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify({ meta: { fetched_at: now }, records: {} }));
    const legacy = await runInternalAudit(repo, { graph, advisoryStorePath: legacyPath, skipMalwareScan: true });
    assert.equal(legacy.checks.osv.status, "NOT_CHECKED");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("internal audit suppresses convention/generated/config-excluded dead and unused noise", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-classification-"));
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
    writeFileSync(join(repo, ".weavatrix.json"), JSON.stringify({ exclude: ["src/legacy/**"] }));
    const sources = {
      "src/product.ts": "export function uniqueProductSignal() { return 1; }\n",
      "src/Button.stories.tsx": "export function uniqueStorySignal() { return 2; }\n",
      "src/mockData.ts": "export function uniqueMockSignal() { return 3; }\n",
      "src/generated/client.ts": "// generated code - do not edit\nexport function uniqueGeneratedSignal() { return 4; }\n",
      "src/legacy/old.ts": "export function uniqueLegacySignal() { return 5; }\n",
    };
    const nodes = [];
    const links = [];
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(join(repo, file.replace(/[/\\][^/\\]+$/, "")), { recursive: true });
      writeFileSync(join(repo, file), source);
      const name = source.match(/function\s+(\w+)/)[1];
      nodes.push({ id: file, source_file: file, file_type: "code" });
      nodes.push({ id: `${file}#${name}@2`, label: `${name}()`, source_file: file, source_location: "L2", exported: true });
      links.push({ source: file, target: `${file}#${name}@2`, relation: "contains" });
    }
    const audit = await runInternalAudit(repo, {
      graph: { nodes, links, externalImports: [] },
      advisoryStorePath: join(repo, "missing-advisories.json"),
      skipMalwareScan: true,
    });
    assert.equal(audit.ok, true);
    assert.ok(audit.findings.some((finding) => finding.file === "src/product.ts" && finding.rule === "unused-export"));
    for (const file of Object.keys(sources).filter((file) => file !== "src/product.ts")) {
      assert.ok(!audit.findings.some((finding) => finding.file === file && ["unused-file", "unused-export", "orphan-file"].includes(finding.rule)), `${file} classification suppresses convention noise`);
    }
    assert.equal(audit.scanned.pathClassifications.story, 1);
    assert.equal(audit.scanned.pathClassifications.mock, 1);
    assert.equal(audit.scanned.pathClassifications.generated, 1);
    assert.equal(audit.scanned.pathClassificationExcluded, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("internal audit maps Java imports to Maven and Gradle declarations with review evidence", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-jvm-deps-"));
  try {
    const javaFile = "src/main/java/com/acme/App.java";
    mkdirSync(join(repo, "src", "main", "java", "com", "acme"), { recursive: true });
    writeFileSync(join(repo, javaFile), "package com.acme; class App { void run() {} }\n");
    writeFileSync(join(repo, "pom.xml"), [
      "<project>",
      "  <dependencyManagement><dependencies>",
      "    <dependency><groupId>managed</groupId><artifactId>not-direct</artifactId></dependency>",
      "  </dependencies></dependencyManagement>",
      "  <dependencies>",
      "    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency>",
      "    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency>",
      "  </dependencies>",
      "</project>",
    ].join("\n"));
    writeFileSync(join(repo, "build.gradle.kts"), "dependencies {\n  implementation(\"com.google.guava:guava:33.0.0-jre\")\n}\n");
    const audit = await runInternalAudit(repo, {
      graph: {
        nodes: [{ id: javaFile, source_file: javaFile, file_type: "code" }],
        links: [],
        externalImports: [{ file: javaFile, spec: "org.slf4j.Logger", pkg: "org.slf4j", ecosystem: "Maven", line: 1 }],
      },
      advisoryStorePath: join(repo, "missing-advisories.json"),
      skipMalwareScan: true,
    });

    assert.equal(audit.ok, true);
    assert.equal(audit.dependencyReport.status, "COMPLETE");
    assert.equal(audit.dependencyReport.ecosystems.maven.status, "CHECKED");
    assert.equal(audit.dependencyReport.ecosystems.maven.completeness, "COMPLETE");
    assert.equal(audit.dependencyReport.ecosystems.maven.declared, 2);
    assert.equal(audit.dependencyReport.ecosystems.gradle.status, "CHECKED");
    assert.equal(audit.dependencyReport.ecosystems.gradle.completeness, "COMPLETE");
    assert.equal(audit.dependencyReport.ecosystems.gradle.declared, 1);
    assert.equal(audit.dependencyReport.declared, 3);
    assert.equal(audit.dependencyReport.missing, 0, "an unmapped Java package must not become a false npm missing-dependency finding");
    assert.equal(audit.dependencyReport.unused, 2);
    assert.match(audit.dependencyReport.reason, /complete supported manifest-to-import evidence/);
    assert.equal(audit.healthCapabilities.dependencies.status, "CHECKED");
    assert.equal(audit.healthCapabilities.dependencies.completeness, "COMPLETE");
    assert.equal(audit.healthCapabilities.advisories.status, "NOT_CHECKED");
    assert.equal(audit.healthCapabilities.malware.status, "NOT_SUPPORTED");
    assert.equal(audit.healthCapabilities.coverage.status, "NOT_SUPPORTED");
    assert.equal(audit.healthCapabilities.concurrency.status, "CHECKED");
    assert.match(audit.healthCapabilities.concurrency.detail, /No race detector ran/);
    const text = formatOrdinaryAudit(audit, {});
    assert.match(text, /Dependency manifests: COMPLETE/);
    assert.match(text, /checked 3 declared package/);
    assert.match(text, /unused 2, missing 0/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("mixed npm and Maven dependency summary reports both checked ecosystems", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-audit-mixed-deps-"));
  try {
    const jsFile = "src/index.js";
    const javaFile = "src/main/java/com/acme/App.java";
    mkdirSync(join(repo, "src", "main", "java", "com", "acme"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "mixed", dependencies: { "left-pad": "1.3.0" } }));
    writeFileSync(join(repo, "pom.xml"), "<project><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency></dependencies></project>\n");
    writeFileSync(join(repo, jsFile), "import leftPad from 'left-pad'; console.log(leftPad);\n");
    writeFileSync(join(repo, javaFile), "package com.acme; import org.slf4j.Logger; class App {}\n");
    const audit = await runInternalAudit(repo, {
      graph: {
        nodes: [jsFile, javaFile].map((file) => ({ id: file, source_file: file, file_type: "code" })),
        links: [],
        externalImports: [
          { file: jsFile, spec: "left-pad", pkg: "left-pad", ecosystem: "npm", line: 1 },
          { file: javaFile, spec: "org.slf4j.Logger", pkg: "org.slf4j", ecosystem: "Maven", line: 1 },
        ],
      },
      advisoryStorePath: join(repo, "missing-advisories.json"),
      skipMalwareScan: true,
    });

    assert.equal(audit.dependencyReport.status, "COMPLETE");
    assert.equal(audit.dependencyReport.ecosystems.npm.status, "CHECKED");
    assert.equal(audit.dependencyReport.ecosystems.maven.status, "CHECKED");
    const text = formatOrdinaryAudit(audit, {});
    assert.match(text, /checked 2 declared package/);
    assert.match(text, /against 2 external import/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
