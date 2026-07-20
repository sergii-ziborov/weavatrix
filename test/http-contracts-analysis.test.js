import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHttpContracts } from "../src/analysis/http-contracts.js";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "wx-http-contract-"));
  for (const [file, text] of Object.entries(files)) {
    const full = join(root, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

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
    assert.equal(users.liveness.status, "NOT_DEAD_EXTERNAL_USE");
    assert.deepEqual(users.liveness.consumerRepositories, ["mobile", "web"]);
    assert.deepEqual(users.affected.files.map((entry) => [entry.file, entry.distance]), [
      ["src/client.ts", 0], ["src/api/users.ts", 0], ["src/features/UserView.tsx", 1], ["src/pages/UsersPage.tsx", 2],
    ]);
    assert.deepEqual(users.affected.screens.map((entry) => entry.file), ["src/pages/UsersPage.tsx"]);
    const items = result.endpoints.find((endpoint) => endpoint.method === "DELETE");
    assert.equal(items.callsites[0].match.kind, "exact-dynamic");
    assert.equal(items.callsites[0].match.confidence, "medium");
    assert.equal(items.liveness.status, "NOT_DEAD_EXTERNAL_USE");
    assert.ok(result.uncertain.some((call) => call.file === "src/api/items.ts" && /dynamic component/.test(call.reason)));
    assert.equal(result.totals.methodMismatches, 1);
    assert.equal(users.methodMismatches, 1, "the rejected shape-matching POST survives as per-endpoint mismatch evidence");
    assert.deepEqual(users.methodMismatchSites.map((site) => [site.clientRepo, site.file, site.method]), [["web", "src/api/users.ts", "POST"]]);
    assert.equal(typeof users.methodMismatchSites[0].line, "number");
    assert.equal(items.methodMismatches, 0);
    assert.deepEqual(items.methodMismatchSites, []);
    assert.doesNotMatch(JSON.stringify(result), /export const|getUser\(1\)/, "structured evidence never contains source text");
  } finally {
    rmSync(backend, { recursive: true, force: true });
    rmSync(frontend, { recursive: true, force: true });
    rmSync(mobile, { recursive: true, force: true });
  }
});

test("auto-discovery traces an imported bare wrapper only through its graph import scope", () => {
  const backend = repo({
    "src/routes.js": `router.get('/api/users/:id', getUser);`,
  });
  const frontend = repo({
    "src/http.ts": `export const get = <T>(url: string): Promise<T> => axios.get<T>(url);`,
    "src/users.ts": `import {get} from './http'; export const load = () => get<unknown>('/api/users/42');`,
    "src/unrelated.ts": `export const local = () => get('/api/users/99');`,
  });
  const backendGraph = {
    nodes: [
      { id: "src/routes.js", label: "routes.js", source_file: "src/routes.js" },
      { id: "src/routes.js#getUser@10", label: "getUser()", source_file: "src/routes.js", source_location: "L10" },
    ],
    links: [],
  };
  const clientGraph = {
    nodes: [
      { id: "http", source_file: "src/http.ts" },
      { id: "users", source_file: "src/users.ts" },
      { id: "unrelated", source_file: "src/unrelated.ts" },
    ],
    links: [{ source: "users", target: "http", relation: "imports" }],
  };
  try {
    const result = analyzeHttpContracts({
      backend: { id: "api", repoRoot: backend, codeFiles: ["src/routes.js"], graph: backendGraph },
      clients: [{ id: "web", repoRoot: frontend, codeFiles: ["src/http.ts", "src/users.ts", "src/unrelated.ts"], graph: clientGraph }],
    });
    const endpoint = result.endpoints[0];
    assert.equal(endpoint.callsites.length, 1, "the unrelated same-name function is outside the wrapper import scope");
    assert.equal(endpoint.callsites[0].file, "src/users.ts");
    assert.equal(endpoint.callsites[0].wrapper.definitionFile, "src/http.ts");
    assert.equal(endpoint.handlerNodeId, "src/routes.js#getUser@10");
    assert.equal(endpoint.liveness.status, "NOT_DEAD_EXTERNAL_USE");
    assert.equal(endpoint.liveness.canSuppressDeadCandidate, true);
    assert.equal(result.wrapperDiscovery[0].discovered, 1);
    assert.equal(result.totals.notDeadExternalUse, 1);
    assert.equal(result.totals.notDeadExternalHandlers, 1);
  } finally {
    rmSync(backend, { recursive: true, force: true });
    rmSync(frontend, { recursive: true, force: true });
  }
});

test("auto-discovery follows a fixed client method passed with its transport argument array", () => {
  const backend = repo({
    "src/routes.js": `router.get('/edgeAnalytics/query/:id', getQuery); router.post('/edgeAnalytics/query', saveQuery); router.delete('/edgeAnalytics/query/:id', deleteQuery);`,
  });
  const frontend = repo({
    "src/http.ts": `
      const api = (fn, args) => fn.apply(axios, args);
      export const get = (url, options = {}) => api(axios.get, [url, options]);
      export const post = (url, body) => api(axios.post, [url, body]);
      export const del = (url, data) => api(axios.delete, [url, {data}]);
    `,
    "src/query.ts": `
      import {get, post, del} from './http';
      export const load = (id) => get(\`/edgeAnalytics/query/\${id}\`);
      export const save = (body) => post('/edgeAnalytics/query', body);
      export const remove = (id) => del(\`/edgeAnalytics/query/\${id}\`);
    `,
  });
  const clientGraph = {
    nodes: [
      { id: "http", source_file: "src/http.ts" },
      { id: "query", source_file: "src/query.ts" },
    ],
    links: [{ source: "query", target: "http", relation: "imports" }],
  };
  try {
    const result = analyzeHttpContracts({
      backend: { id: "api", repoRoot: backend, codeFiles: ["src/routes.js"] },
      clients: [{ id: "web", repoRoot: frontend, codeFiles: ["src/http.ts", "src/query.ts"], graph: clientGraph }],
    });
    assert.equal(result.wrapperDiscovery[0].discovered, 3);
    assert.equal(result.totals.matches, 3);
    assert.equal(result.totals.notDeadExternalUse, 3);
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.callsites[0].method).sort(), ["DELETE", "GET", "POST"]);
    assert.ok(result.endpoints.every((endpoint) => endpoint.callsites[0].detector === "auto-wrapper"));
  } finally {
    rmSync(backend, { recursive: true, force: true });
    rmSync(frontend, { recursive: true, force: true });
  }
});

test("handler resolution prefers the unique matching symbol in a directly imported module", () => {
  const frontend = repo({ "src/users.js": `fetch('/api/users/42');` });
  const backendGraph = {
    nodes: [
      { id: "src/routes.js", label: "routes.js", source_file: "src/routes.js" },
      { id: "src/handlers.js", label: "handlers.js", source_file: "src/handlers.js" },
      { id: "src/handlers.js#getUser@12", label: "getUser()", source_file: "src/handlers.js" },
      { id: "src/service.js#getUser@30", label: "getUser()", source_file: "src/service.js" },
    ],
    links: [{ source: "src/routes.js", target: "src/handlers.js", relation: "imports" }],
  };
  try {
    const result = analyzeHttpContracts({
      backend: {
        id: "api",
        graph: backendGraph,
        endpoints: [{ method: "GET", path: "/api/users/:id", handler: "getUser", file: "src/routes.js", line: 4 }],
      },
      clients: [{ id: "web", repoRoot: frontend, codeFiles: ["src/users.js"] }],
    });
    assert.equal(result.endpoints[0].handlerNodeId, "src/handlers.js#getUser@12");
    assert.equal(result.endpoints[0].handlerResolution, "resolved");
    assert.equal(result.endpoints[0].liveness.canSuppressDeadCandidate, true);
  } finally {
    rmSync(frontend, { recursive: true, force: true });
  }
});

test("repository config enables wrappers and missing external evidence remains UNKNOWN", () => {
  const frontend = repo({
    ".weavatrix.json": JSON.stringify({
      httpContracts: { wrappers: [{ call: "read", method: "GET", urlArgument: 0 }] },
    }),
    "src/client.ts": `read('/api/configured');`,
  });
  try {
    const matched = analyzeHttpContracts({
      backend: { id: "api", endpoints: [{ method: "GET", path: "/api/configured", handler: "configured", file: "src/routes.js", line: 1 }] },
      client: { id: "web", repoRoot: frontend, codeFiles: ["src/client.ts"] },
    });
    assert.equal(matched.endpoints[0].liveness.status, "NOT_DEAD_EXTERNAL_USE");
    assert.equal(matched.wrapperDiscovery[0].configured, 1);

    const unknown = analyzeHttpContracts({
      backend: { id: "api", endpoints: [{ method: "DELETE", path: "/api/unused", handler: "unused", file: "src/routes.js", line: 2 }] },
      client: { id: "web", repoRoot: frontend, codeFiles: ["src/client.ts"] },
    });
    assert.equal(unknown.endpoints[0].liveness.status, "UNKNOWN");
    assert.match(unknown.endpoints[0].liveness.reason, /not a dead-code verdict/i);
  } finally {
    rmSync(frontend, { recursive: true, force: true });
  }
});

test("a low-confidence suffix match remains POSSIBLE_EXTERNAL_USE and cannot suppress dead code", () => {
  const frontend = repo({
    "src/client.ts": "export const load = (id) => fetch(`${API_ROOT}/api/users/${id}`);",
  });
  try {
    const result = analyzeHttpContracts({
      backend: {
        id: "api",
        endpoints: [{ method: "GET", path: "/v1/api/users/:id", handler: "getUser", file: "src/routes.js", line: 1 }],
        graph: { nodes: [{ id: "handler", label: "getUser()", source_file: "src/routes.js" }], links: [] },
      },
      client: { id: "web", repoRoot: frontend, codeFiles: ["src/client.ts"] },
    });
    assert.equal(result.endpoints[0].callsites[0].match.confidence, "low");
    assert.equal(result.endpoints[0].liveness.status, "POSSIBLE_EXTERNAL_USE");
    assert.equal(result.endpoints[0].liveness.canSuppressDeadCandidate, false);
  } finally {
    rmSync(frontend, { recursive: true, force: true });
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

test("endpoint path filter accepts a segment-aligned fragment without losing the backend prefix", () => {
  const result = analyzeHttpContracts({
    backend: {
      id: "api",
      endpoints: [{ method: "GET", path: "/edgeAnalytics/query/:id", file: "src/routes.js", line: 1 }],
    },
    clients: [],
    path: "/query",
  });
  assert.equal(result.totals.endpoints, 1);
  assert.equal(result.endpoints[0].normalizedPath, "/edgeAnalytics/query/:param");
  assert.equal(result.endpoints[0].liveness.status, "UNKNOWN");
});
