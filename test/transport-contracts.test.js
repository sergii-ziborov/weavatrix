import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeTransportContracts } from "../src/analysis/transport-contracts.js";

function repo(root, files) {
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, file); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text);
  }
}

test("transport contracts join GraphQL fields, gRPC service methods, and event topics", () => {
  const workspace = mkdtempSync(join(tmpdir(), "weavatrix-transports-"));
  const backendRoot = join(workspace, "backend"), clientRoot = join(workspace, "client");
  try {
    repo(backendRoot, {
      "schema.graphql": "type Query { user(id: ID!): User }\ntype User { id: ID! }\n",
      "user.proto": "service User { rpc GetUser (GetUserRequest) returns (UserReply); }\n",
      "events.ts": "eventBus.on('user.created', handleUser);\n",
    });
    repo(clientRoot, {
      "src/api.ts": "const document = gql`query CurrentUser($id: ID!) { user(id: $id) { id } }`;\nconst grpc = new UserServiceClient(); grpc.GetUser({id: 1});\nproducer.publish('user.created', payload);\nproducer.publish(topicName, payload);\n",
      "src/pages/UserPage.tsx": "import { load } from '../api'; export const UserPage = () => load();\n",
    });
    const clientGraph = {
      nodes: [{ id: "api", source_file: "src/api.ts" }, { id: "page", source_file: "src/pages/UserPage.tsx" }],
      links: [{ source: "page", target: "api", relation: "imports" }],
    };
    const result = analyzeTransportContracts({
      backend: { id: "backend", repoRoot: backendRoot, graph: { nodes: [], links: [] } },
      clients: [{ id: "client", repoRoot: clientRoot, graph: clientGraph }],
    });
    assert.equal(result.totals.contracts, 3);
    assert.equal(result.totals.matches, 3);
    assert.equal(result.totals.uncertain, 1);
    assert.equal(result.status, "PARTIAL");
    assert.deepEqual(result.contracts.map((item) => [item.transport, item.name, item.callsites.length]).sort(), [
      ["event", "user.created", 1], ["graphql", "user", 1], ["grpc", "GetUser", 1],
    ]);
    assert.ok(result.contracts.every((item) => item.liveness === "NOT_DEAD_EXTERNAL_USE"));
    assert.ok(result.contracts.every((item) => item.affected.files.some((file) => file.file === "src/pages/UserPage.tsx")));
    assert.match(result.completeness.reasons.join(" "), /remain UNKNOWN/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("transport filter isolates one contract family", () => {
  const workspace = mkdtempSync(join(tmpdir(), "weavatrix-transport-filter-"));
  const backendRoot = join(workspace, "backend"), clientRoot = join(workspace, "client");
  try {
    repo(backendRoot, { "schema.graphql": "type Mutation { saveUser(id: ID!): Boolean }\n" });
    repo(clientRoot, { "api.ts": "gql`mutation Save { saveUser(id: 1) }`;\n" });
    const result = analyzeTransportContracts({
      transport: "graphql",
      backend: { id: "backend", repoRoot: backendRoot, graph: {} },
      clients: [{ id: "client", repoRoot: clientRoot, graph: {} }],
    });
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.runtimeEvidence.status, "PARTIAL");
    assert.deepEqual(result.contracts.map((item) => [item.operation, item.name]), [["MUTATION", "saveUser"]]);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("fresh revision-bound runtime evidence resolves dynamic GraphQL, gRPC and event identities", () => {
  const workspace = mkdtempSync(join(tmpdir(), "weavatrix-transport-runtime-"));
  const backendRoot = join(workspace, "backend"), clientRoot = join(workspace, "client");
  const generatedAt = "2026-07-19T12:00:00.000Z";
  const report = (revision, observations) => JSON.stringify({
    schema: "weavatrix.transport-runtime.v1",
    repositoryRevision: revision,
    generatedAt,
    coverage: { graphql: "COMPLETE", grpc: "COMPLETE", event: "COMPLETE" },
    observations,
  });
  try {
    repo(backendRoot, {
      "src/runtime.ts": "gql`${schema}`;\nServerReflection.enable(server);\neventBus.subscribe(topicName, handler);\n",
      ".weavatrix/transport-runtime.json": report("backend-revision", [
        { transport: "graphql", side: "server", operation: "QUERY", name: "user", file: "src/runtime.ts", line: 1, observedCount: 8 },
        { transport: "grpc", side: "server", service: "User", name: "GetUser", file: "src/runtime.ts", line: 2, observedCount: 5 },
        { transport: "event", side: "subscriber", name: "user.created", file: "src/runtime.ts", line: 3, observedCount: 13 },
      ]),
    });
    repo(clientRoot, {
      "src/api.ts": "query(document);\ndynamicStub.invoke(methodName);\nproducer.publish(topicName, payload);\n",
      "src/page.ts": "import './api';\n",
      ".weavatrix/transport-runtime.json": report("client-revision", [
        { transport: "graphql", side: "client", operation: "QUERY", name: "user", file: "src/api.ts", line: 1, observedCount: 8 },
        { transport: "grpc", side: "client", service: "User", name: "GetUser", file: "src/api.ts", line: 2, observedCount: 5 },
        { transport: "event", side: "publisher", name: "user.created", file: "src/api.ts", line: 3, observedCount: 13 },
      ]),
    });
    const result = analyzeTransportContracts({
      now: Date.parse("2026-07-19T13:00:00.000Z"),
      backend: { id: "backend", repoRoot: backendRoot, graph: { graphRevision: "backend-revision", nodes: [], links: [] } },
      clients: [{ id: "client", repoRoot: clientRoot, graph: {
        graphRevision: "client-revision",
        nodes: [{ id: "api", source_file: "src/api.ts" }, { id: "page", source_file: "src/page.ts" }],
        links: [{ source: "page", target: "api", relation: "imports" }],
      } }],
    });
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.totals.contracts, 3);
    assert.equal(result.totals.matches, 3);
    assert.equal(result.totals.uncertain, 0);
    assert.equal(result.totals.runtimeObservations, 6);
    assert.equal(result.totals.runtimeResolved, 6);
    assert.equal(result.runtimeEvidence.status, "COMPLETE");
    assert.ok(result.contracts.every((item) => item.runtimeObserved));
    assert.ok(result.contracts.every((item) => item.callsites[0].match.evidence === "RUNTIME_OBSERVED"));
    assert.ok(result.contracts.every((item) => item.affected.files.some((file) => file.file === "src/page.ts")));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
