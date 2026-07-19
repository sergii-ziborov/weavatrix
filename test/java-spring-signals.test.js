import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEndpointsFromText, detectEndpoints } from "../src/analysis/endpoints.js";
import { runInternalAudit } from "../src/analysis/internal-audit.js";
import { aggregateGraph, folderModuleOf } from "../src/analysis/graph-analysis.js";

const endpoint = (items, method, path) => items.find((item) => item.method === method && item.path === path);

test("Spring endpoints compose class and method mappings with literal paths and exact annotation lines", () => {
  const source = [
    "@RestController",
    "@RequestMapping(path = {\"/api/v1\", \"/api/latest\"})",
    "class UsersController {",
    "  // @GetMapping(\"/users/{id}\") old route kept only as migration documentation",
    "  @GetMapping(path = \"/users/{id}\", produces = \"application/json\")",
    "  public ResponseEntity<User> find(@PathVariable String id) { return null; }",
    "",
    "  @RequestMapping(value = {\"/users\", \"/people\"}, method = {RequestMethod.POST, RequestMethod.PUT})",
    "  public void save(@RequestBody User user) {}",
    "",
    "  @DeleteMapping",
    "  public void purge() {}",
    "",
    "  @GetMapping(Paths.INTERNAL)",
    "  public void unresolved() {}",
    "}",
  ].join("\n");
  const found = extractEndpointsFromText(source, "application/src/main/java/com/acme/UsersController.java");
  assert.equal(found.length, 12, "2 class prefixes × (GET + 2 POST + 2 PUT + root DELETE); unresolved constants are omitted");
  assert.equal(endpoint(found, "GET", "/api/v1/users/{id}").handler, "find");
  assert.equal(endpoint(found, "GET", "/api/v1/users/{id}").line, 5);
  assert.equal(endpoint(found, "POST", "/api/latest/people").handler, "save");
  assert.equal(endpoint(found, "PUT", "/api/v1/users").line, 8);
  assert.equal(endpoint(found, "DELETE", "/api/latest").handler, "purge");
  assert.ok(!found.some((item) => item.handler === "unresolved"));
});

test("repository endpoint inventory reads Java files and recognizes fully-qualified Spring annotations", () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-spring-endpoints-"));
  try {
    const file = "src/main/java/com/acme/StatusController.java";
    mkdirSync(join(repo, "src", "main", "java", "com", "acme"), { recursive: true });
    writeFileSync(join(repo, file), [
      "@org.springframework.web.bind.annotation.RestController",
      "@org.springframework.web.bind.annotation.RequestMapping(\"/status\")",
      "class StatusController {",
      "  @org.springframework.web.bind.annotation.GetMapping(\"/ready\")",
      "  public String ready() { return \"ok\"; }",
      "}",
    ].join("\n"));
    const found = detectEndpoints(repo, [file]);
    assert.deepEqual(found, [{
      method: "GET", path: "/status/ready", declaredPath: "/status/ready", handler: "ready", file, line: 4,
      mountState: "DECLARED_LOCAL", confidence: "medium", mountChain: [],
    }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Spring endpoint inventory preserves conditional activation and default-inactive metadata", () => {
  const source = [
    "@RestController",
    "@ConditionalOnExpression(\"${feature.controller:false}\")",
    "@RequestMapping(\"/api\")",
    "class FeatureController {",
    "  @GetMapping(\"/read\")",
    "  public String read() { return \"ok\"; }",
    "",
    "  @ConditionalOnProperty(prefix = \"feature\", name = {\"write\", \"api\"}, havingValue = \"true\", matchIfMissing = false)",
    "  @PostMapping(\"/write\")",
    "  public void write() {}",
    "}",
    "",
    "@RestController",
    "@ConditionalOnProperty(prefix = \"feature\", name = \"optional\", matchIfMissing = true)",
    "@RequestMapping(\"/optional\")",
    "class OptionalController {",
    "  @GetMapping",
    "  public String get() { return \"ok\"; }",
    "}",
  ].join("\n");

  const found = extractEndpointsFromText(source, "src/main/java/com/acme/FeatureController.java");
  const read = endpoint(found, "GET", "/api/read");
  const write = endpoint(found, "POST", "/api/write");
  const optional = endpoint(found, "GET", "/optional");

  assert.equal(read.conditional, true);
  assert.equal(read.defaultActive, false);
  assert.deepEqual(read.conditions.map((condition) => condition.type), ["ConditionalOnExpression"]);
  assert.equal(read.conditions[0].expression, "${feature.controller:false}");
  assert.equal(write.defaultActive, false);
  assert.deepEqual(write.conditions.map((condition) => condition.type), ["ConditionalOnExpression", "ConditionalOnProperty"]);
  assert.deepEqual(write.conditions[1].properties, ["write", "api"]);
  assert.equal(write.conditions[1].matchIfMissing, false);
  assert.equal(optional.defaultActive, true);
  assert.equal(optional.conditions[0].prefix, "feature");
});

test("Spring-managed application, configuration, component and repository files are explainable convention roots", async () => {
  const repo = mkdtempSync(join(tmpdir(), "weavatrix-spring-audit-"));
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "spring-fixture" }));
    const sources = {
      "src/main/java/com/acme/Application.java": "@SpringBootApplication\nclass Application { static void boot() {} }\n",
      "src/main/java/com/acme/config/RedisConfig.java": "@Configuration\nclass RedisConfig { Object redis() { return null; } }\n",
      "src/main/java/com/acme/events/KafkaCustomErrorHandler.java": "@Component\nclass KafkaCustomErrorHandler { void handle() {} }\n",
      "src/main/java/com/acme/data/UserRepository.java": "interface UserRepository extends JpaRepository<User, Long> {}\n",
      "src/main/java/com/acme/LegacyHelper.java": "// @Component is only mentioned in migration docs\nclass LegacyHelper { void abandoned() {} }\n",
    };
    const nodes = [];
    const links = [];
    let line = 1;
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(join(repo, file.slice(0, file.lastIndexOf("/"))), { recursive: true });
      writeFileSync(join(repo, file), source);
      const symbol = `${file}#symbol@${line++}`;
      nodes.push({ id: file, source_file: file, file_type: "code" });
      nodes.push({ id: symbol, source_file: file, file_type: "code", label: `symbol${line}()`, source_location: "L1" });
      links.push({ source: file, target: symbol, relation: "contains" });
    }
    const audit = await runInternalAudit(repo, {
      graph: { nodes, links, externalImports: [] },
      advisoryStorePath: join(repo, "advisories-missing.json"),
      skipMalwareScan: true,
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.conventionReachability.count, 4);
    assert.equal(audit.scanned.conventionEntrypoints, 4);
    for (const file of Object.keys(sources).filter((file) => !file.endsWith("LegacyHelper.java"))) {
      assert.ok(!audit.findings.some((finding) => finding.file === file && ["unused-file", "orphan-file"].includes(finding.rule)), `${file} is framework-reachable`);
    }
    assert.ok(audit.findings.some((finding) => finding.file.endsWith("LegacyHelper.java") && finding.rule === "unused-file"));
    const repository = audit.conventionReachability.entries.find((item) => item.file.endsWith("UserRepository.java"));
    assert.equal(repository.framework, "spring-data");
    assert.equal(repository.confidence, "high");
    assert.match(repository.reason, /proxy/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Java module aggregation uses package territories below src/main/java", () => {
  const files = [
    "application/src/main/java/com/acme/orders/web/OrderController.java",
    "application/src/main/java/com/acme/orders/service/OrderService.java",
    "application/src/main/java/com/acme/billing/service/BillingService.java",
  ];
  const graph = {
    nodes: files.map((file) => ({ id: file, source_file: file, file_type: "code" })),
    links: [
      { source: files[0], target: files[1], relation: "imports" },
      { source: files[1], target: files[2], relation: "imports" },
    ],
  };
  const aggregated = aggregateGraph(graph, null);
  assert.deepEqual(aggregated.modules.map((item) => item.name).sort(), [
    "application/src/main/java/com/acme/billing/service",
    "application/src/main/java/com/acme/orders/service",
    "application/src/main/java/com/acme/orders/web",
  ]);
  assert.equal(aggregated.totals.moduleEdges, 2);
  assert.ok(aggregated.moduleEdges.some((edge) => edge.from.endsWith("orders/web") && edge.to.endsWith("orders/service")));
  assert.equal(folderModuleOf(files[0]), "application/src/main/java/com/acme/orders/web");
});
