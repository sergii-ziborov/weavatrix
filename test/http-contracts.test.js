import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeHttpContracts,
  extractHttpClientCallsFromText,
  matchHttpContract,
  normalizeHttpContractPath,
} from "../src/analysis/http-contracts.js";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "wx-http-contract-"));
  for (const [file, text] of Object.entries(files)) {
    const full = join(root, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

test("HTTP client extraction normalizes literals/templates and keeps unknown URLs explicitly uncertain", () => {
  const text = `
    axios.get('/api/users/42?full=1');
    apiClient.post(\`/api/users/\${id}\`, payload);
    fetch(\`\${API_BASE}/api/items/\${id}\`, { method: 'DELETE' });
    http.get(dynamicUrl);
    fetch('/api/configured', requestOptions);
    // axios.get('/commented-out')
    const prose = "apiClient.post('/inside-a-string')";
  `;
  const result = extractHttpClientCallsFromText(text, "src/api.ts");
  assert.deepEqual(result.calls.map((call) => [call.method, call.path, call.dynamic, call.unknownPrefix]), [
    ["GET", "/api/users/42", false, false],
    ["POST", "/api/users/:param", true, false],
    ["DELETE", "/api/items/:param", true, true],
    ["GET", null, true, false],
    ["UNKNOWN", "/api/configured", false, false],
  ]);
  assert.match(result.calls[3].reason, /not a string or template/);
  assert.match(result.calls[4].reason, /method is dynamic/i);
});

test("contract matching requires the method and labels exact, concrete-parameter and suffix evidence", () => {
  const endpoint = { method: "GET", path: "/api/users/:id" };
  assert.equal(matchHttpContract(endpoint, { method: "POST", path: "/api/users/42" }), null, "method mismatch is never promoted");
  assert.deepEqual(matchHttpContract(endpoint, { method: "GET", path: "/api/users/42", dynamic: false }), {
    kind: "exact", confidence: "high", score: 0.96,
    reason: "method matches and a backend parameter accepts the concrete client segment",
  });
  const suffix = matchHttpContract({ method: "GET", path: "/v1/api/users/:id" }, { method: "GET", path: "/api/users/:param", dynamic: false });
  assert.equal(suffix.kind, "suffix");
  assert.equal(suffix.confidence, "medium");
  assert.equal(matchHttpContract({ method: "GET", path: "/v1/api/users/:id" }, { method: "GET", path: "/api/users/42", dynamic: false }).kind, "suffix", "a concrete client ID also matches a backend parameter through suffix alignment");
  assert.equal(normalizeHttpContractPath("/api/users/{id}"), "/api/users/:param");
});

test("cross-repo analysis joins real backend endpoints and follows bounded reverse imports to screens", () => {
  const backend = repo({
    "src/routes.js": `router.get('/api/users/:id', getUser); router.post('/api/users', createUser); router.delete('/api/items/:id', deleteItem);`,
  });
  const frontend = repo({
    "src/api/users.ts": `export const getUser = (id) => axios.get(\`/api/users/\${id}\`);\nexport const wrong = () => axios.post('/api/users/42');`,
    "src/api/items.ts": `export const remove = (id) => fetch(\`\${API_BASE}/api/items/\${id}\`, {method: 'DELETE'});`,
    "src/features/UserView.tsx": "import { getUser } from '../api/users'; export const UserView = () => getUser(1);",
    "src/pages/UsersPage.tsx": "import { UserView } from '../features/UserView'; export const UsersPage = UserView;",
  });
  const mobile = repo({ "src/client.ts": "export const load = () => axios.get('/api/users/7');" });
  const graph = {
    nodes: [
      { id: "api", source_file: "src/api/users.ts" },
      { id: "view", source_file: "src/features/UserView.tsx" },
      { id: "page", source_file: "src/pages/UsersPage.tsx" },
    ],
    links: [
      { source: "view", target: "api", relation: "imports" },
      { source: "page", target: "view", relation: "imports" },
    ],
  };
  try {
    const result = analyzeHttpContracts({
      backends: [{ id: "api", repoRoot: backend, codeFiles: ["src/routes.js"] }],
      clients: [
        { id: "web", repoRoot: frontend, codeFiles: ["src/api/users.ts", "src/api/items.ts", "src/features/UserView.tsx", "src/pages/UsersPage.tsx"], graph },
        { id: "mobile", repoRoot: mobile, codeFiles: ["src/client.ts"] },
      ],
      maxImpactDepth: 2,
    });
    const users = result.endpoints.find((endpoint) => endpoint.method === "GET" && endpoint.path === "/api/users/:id");
    assert.equal(users.callsites.length, 2, "both client repositories join while the POST call with the same path shape is rejected");
    assert.deepEqual(users.callsites.map((call) => call.clientRepo), ["web", "mobile"], "exact normalized templates rank just ahead of concrete parameter instances");
    assert.equal(users.callsites[0].match.confidence, "high");
    assert.deepEqual(users.affected.files.map((entry) => [entry.file, entry.distance]), [
      ["src/client.ts", 0], ["src/api/users.ts", 0], ["src/features/UserView.tsx", 1], ["src/pages/UsersPage.tsx", 2],
    ]);
    assert.deepEqual(users.affected.screens.map((entry) => entry.file), ["src/pages/UsersPage.tsx"]);
    const items = result.endpoints.find((endpoint) => endpoint.method === "DELETE");
    assert.equal(items.callsites[0].match.kind, "exact-dynamic");
    assert.equal(items.callsites[0].match.confidence, "medium");
    assert.ok(result.uncertain.some((call) => call.file === "src/api/items.ts" && /dynamic component/.test(call.reason)));
    assert.equal(result.totals.methodMismatches, 1);
    assert.doesNotMatch(JSON.stringify(result), /export const|getUser\(1\)/, "structured evidence never contains source text");
  } finally {
    rmSync(backend, { recursive: true, force: true });
    rmSync(frontend, { recursive: true, force: true });
    rmSync(mobile, { recursive: true, force: true });
  }
});

test("method/path/changed-file filters and every output cap are deterministic and explicit", () => {
  const backend = repo({
    "src/a.js": `router.get('/api/a/:id', a); router.get('/api/b/:id', b);`,
    "src/other.js": `router.get('/api/c/:id', c);`,
  });
  const frontend = repo({
    "src/client.js": `axios.get('/api/a/1'); axios.get('/api/a/2'); axios.get(url); axios.get(otherUrl);`,
  });
  try {
    const filtered = analyzeHttpContracts({
      backend: { id: "api", repoRoot: backend, codeFiles: ["src/a.js", "src/other.js"] },
      clients: [{ id: "web", repoRoot: frontend, codeFiles: ["src/client.js"] }],
      method: "GET",
      path: "/api/a/:id",
      changedFiles: ["src/a.js"],
      maxEndpoints: 1,
      maxMatches: 1,
      maxCallsitesPerEndpoint: 1,
      maxUncertain: 1,
      maxAffectedFiles: 1,
    });
    assert.equal(filtered.endpoints.length, 1);
    assert.equal(filtered.endpoints[0].callsites.length, 1);
    assert.equal(filtered.uncertain.length, 1);
    assert.equal(filtered.status, "partial");
    assert.ok(filtered.completeness.reasons.some((reason) => /cap/.test(reason)));
    assert.equal(JSON.stringify(filtered), JSON.stringify(analyzeHttpContracts({
      backend: { id: "api", repoRoot: backend, codeFiles: ["src/a.js", "src/other.js"] },
      clients: [{ id: "web", repoRoot: frontend, codeFiles: ["src/client.js"] }],
      method: "GET", path: "/api/a/:id", changedFiles: ["src/a.js"], maxEndpoints: 1, maxMatches: 1,
      maxCallsitesPerEndpoint: 1, maxUncertain: 1, maxAffectedFiles: 1,
    })));
  } finally {
    rmSync(backend, { recursive: true, force: true });
    rmSync(frontend, { recursive: true, force: true });
  }
});
