import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadTransportRuntimeEvidence } from "../src/analysis/transport-runtime-evidence.js";
import { snapshotRepository } from "../src/graph/incremental-refresh.js";

const attr = (key, value) => ({ key, value: { stringValue: value } });

test("OTLP JSON spans normalize GraphQL, gRPC and Kafka runtime identities", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-otlp-"));
  try {
    mkdirSync(join(root, ".weavatrix"), { recursive: true });
    writeFileSync(join(root, ".weavatrix", "transport-runtime.json"), JSON.stringify({
      schema: "weavatrix.transport-runtime.v1",
      repositoryRevision: "revision-a",
      generatedAt: "2026-07-19T12:00:00.000Z",
      coverage: { graphql: "COMPLETE", grpc: "COMPLETE", event: "COMPLETE" },
      resourceSpans: [{ scopeSpans: [{ spans: [
        { kind: "SPAN_KIND_CLIENT", attributes: [attr("graphql.operation.type", "query"), attr("graphql.field.name", "viewer"), attr("code.file.path", "src/client.ts"), { key: "code.line.number", value: { intValue: 7 } }] },
        { kind: "SPAN_KIND_SERVER", name: "example.User/GetUser", attributes: [attr("rpc.system", "grpc"), attr("rpc.service", "example.User"), attr("rpc.method", "GetUser")] },
        { kind: "SPAN_KIND_PRODUCER", attributes: [attr("messaging.system", "kafka"), attr("messaging.destination.name", "user.created")] },
      ] }] }],
    }));
    const result = loadTransportRuntimeEvidence({ id: "repo", repoRoot: root, graph: { graphRevision: "revision-a" } }, {
      now: Date.parse("2026-07-19T13:00:00.000Z"),
    });
    assert.equal(result.status, "COMPLETE");
    assert.deepEqual(result.observations.map((item) => [item.transport, item.side, item.name]), [
      ["graphql", "client", "viewer"],
      ["grpc", "server", "GetUser"],
      ["event", "publisher", "user.created"],
    ]);
    assert.equal(result.observations[0].file, "src/client.ts");
    assert.equal(result.observations[0].line, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime evidence fails closed on revision, freshness and repository path", () => {
  const workspace = mkdtempSync(join(tmpdir(), "weavatrix-runtime-boundary-"));
  const root = join(workspace, "repo");
  try {
    mkdirSync(join(root, ".weavatrix"), { recursive: true });
    writeFileSync(join(root, ".weavatrix", "transport-runtime.json"), JSON.stringify({
      schema: "weavatrix.transport-runtime.v1",
      repositoryRevision: "old-revision",
      generatedAt: "2025-01-01T00:00:00.000Z",
      coverage: { graphql: "COMPLETE", grpc: "COMPLETE", event: "COMPLETE" },
      observations: [],
    }));
    const descriptor = { id: "repo", repoRoot: root, graph: { graphRevision: "current-revision" } };
    const stale = loadTransportRuntimeEvidence(descriptor, { now: Date.parse("2026-07-19T13:00:00.000Z") });
    assert.equal(stale.status, "PARTIAL");
    assert.match(stale.reasons.join(" "), /revision does not match/);
    assert.match(stale.reasons.join(" "), /stale/);
    assert.equal(stale.observations.length, 0);
    const escaped = loadTransportRuntimeEvidence(descriptor, { file: "../outside.json" });
    assert.equal(escaped.status, "ERROR");
    assert.match(escaped.reasons.join(" "), /path is escape/);
    assert.doesNotMatch(escaped.reasons.join(" "), /[A-Z]:\\|\/tmp\//);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("default runtime reports do not mutate the source revision they attest", () => {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-runtime-revision-"));
  try {
    spawnSync("git", ["init", "--quiet", root]);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".weavatrix"), { recursive: true });
    writeFileSync(join(root, "src", "api.ts"), "export const api = 1;\n");
    writeFileSync(join(root, ".weavatrix", "transport-runtime.json"), "{\"first\":true}\n");
    spawnSync("git", ["-C", root, "add", "-f", "src/api.ts", ".weavatrix/transport-runtime.json"]);
    const before = snapshotRepository(root);
    writeFileSync(join(root, ".weavatrix", "transport-runtime.json"), "{\"second\":true}\n");
    const after = snapshotRepository(root);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.relativeFiles, ["src/api.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
