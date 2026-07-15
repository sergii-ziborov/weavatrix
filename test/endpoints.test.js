import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEndpointsFromText, detectEndpoints, nextRoutePath } from "../src/analysis/endpoints.js";

const find = (eps, method, path) => eps.find((e) => e.method === method && e.path === path);

test("endpoints: Bun object routes — \"/path\": { GET: h, POST: h2 } + wrapped handlers", () => {
  const text = `export const buildRoutes = () => ({
    '/health': () => jsonResponse({ok: true}),
    '/edgeAnalytics/query/execute': { POST: executionRoute(queryHandlers.executeQuery) },
    '/edgeAnalytics/query/:id': { GET: queryHandlers.getQuery, PUT: queryHandlers.updateQuery, DELETE: queryHandlers.deleteQuery },
  });`;
  const eps = extractEndpointsFromText(text, "src/http/app.js");
  assert.ok(find(eps, "POST", "/edgeAnalytics/query/execute"), "object route with a wrapped handler");
  assert.equal(find(eps, "POST", "/edgeAnalytics/query/execute").handler, "executeQuery", "handler unwrapped from executionRoute(…)");
  assert.equal(find(eps, "GET", "/edgeAnalytics/query/:id").handler, "getQuery");
  assert.equal(find(eps, "DELETE", "/edgeAnalytics/query/:id").handler, "deleteQuery");
});

test("endpoints: Express/Fastify method calls — app.get / router.post(\"/x\", handler)", () => {
  const text = `app.get('/users', listUsers);
    router.post("/users", validate, createUser);
    api.delete('/users/:id', removeUser);`;
  const eps = extractEndpointsFromText(text, "routes.js");
  assert.equal(find(eps, "GET", "/users").handler, "listUsers");
  assert.equal(find(eps, "POST", "/users").handler, "createUser"); // last identifier arg (past the middleware)
  assert.ok(find(eps, "DELETE", "/users/:id"));
});

test("endpoints: FastAPI/Flask decorators — @app.get(\"/x\") over a def", () => {
  const text = `@router.get("/items")\ndef list_items():\n    return items\n\n@app.post("/items")\ndef create_item(item):\n    return item`;
  const eps = extractEndpointsFromText(text, "api.py");
  assert.equal(find(eps, "GET", "/items").handler, "list_items");
  assert.equal(find(eps, "POST", "/items").handler, "create_item");
});

test("endpoints: Go net/http — mux.HandleFunc(\"/x\", handler) → ANY method", () => {
  const text = `mux.HandleFunc("/metrics", serveMetrics)\n\thttp.Handle("/healthz", healthHandler)`;
  const eps = extractEndpointsFromText(text, "main.go");
  assert.equal(find(eps, "ANY", "/metrics").handler, "serveMetrics");
  assert.ok(find(eps, "ANY", "/healthz"));
});

test("endpoints: non-route strings and URLs are not mistaken for endpoints", () => {
  const text = `const url = "https://api.example.com/v1/users";\n  const label = { title: "hello" };\n  fetch("/not-a-route-but-a-string");`;
  const eps = extractEndpointsFromText(text, "misc.js");
  // a bare "/…" string inside fetch() isn't an object-route or a method call — must not be a GET/POST route
  assert.ok(!eps.some((e) => e.path.includes("example.com")), "absolute URLs excluded");
  assert.ok(!find(eps, "GET", "/not-a-route-but-a-string"), "a lone fetch string is not a declared route");
});

test("endpoints: FRONTEND client HTTP calls (axios/http/fetch/apiClient) are NOT mistaken for server routes", () => {
  const text = `
    const users = await axios.get('/api/users');
    await axios.post('/api/users', payload);
    http.get('/status', (res) => res.pipe(out));
    const r = await apiClient.delete('/api/items/42');
    this.$http.get('/config');
    fetch('/api/data');
    // a real server route in the same file MUST still be found (has a handler)
    router.get('/health', healthHandler);`;
  const eps = extractEndpointsFromText(text, "src/components/UsersView.tsx");
  assert.ok(!eps.some((e) => e.path === "/api/users"), "axios.get/post client calls excluded");
  assert.ok(!eps.some((e) => e.path === "/status"), "http.get client call excluded");
  assert.ok(!eps.some((e) => e.path === "/api/items/42"), "apiClient.delete client call excluded");
  assert.ok(!eps.some((e) => e.path === "/config"), "$http.get client call excluded");
  assert.equal(find(eps, "GET", "/health").handler, "healthHandler", "a real server route (with a handler) is still detected");
});

test("endpoints: an ambiguous caller (api/client) with a CONFIG object, not a handler, is not a route", () => {
  const text = `api.get('/things', { params: { page: 1 } });\n  api.get('/widgets', getWidgets);`;
  const eps = extractEndpointsFromText(text, "src/api.ts");
  assert.ok(!find(eps, "GET", "/things"), "config-object 2nd arg → client call, not a route");
  assert.equal(find(eps, "GET", "/widgets").handler, "getWidgets", "handler 2nd arg → a real route");
});

test("endpoints: OpenAPI/Swagger `paths` spec objects are NOT treated as routes", () => {
  // an *.openapi.js paths object documents routes; its "handlers" are operation()/spec objects
  const text = `const paths = {
    '/edgeAnalytics/dashboard/{id}': {
      get: operation({ summary: 'Get one', operationId: 'getDashboard', responses: { 200: ok } }),
      put: operation({ operationId: 'updateDashboard', responses: { 200: ok } }),
    },
    '/edgeAnalytics/dashboard/clone/{id}': { post: operation({ operationId: 'clone', responses: {} }) },
  };`;
  const eps = extractEndpointsFromText(text, "src/dashboard/dashboard.openapi.js");
  assert.equal(eps.length, 0, "no endpoints extracted from an OpenAPI spec object");
  assert.ok(!eps.some((e) => e.handler === "operation"), "the operation() helper is never a handler");
});

test("endpoints: inline arrow / anonymous handlers resolve to no name (shown as 'inline'), not garbage", () => {
  const text = `export const routes = () => ({
    '/': () => jsonResponse({service: 'edge-analytics', ok: true}),
    '/ping': { GET: (req) => reply(req) },
    '/schema': { GET: queryHandlers.getSchema },
  });`;
  const eps = extractEndpointsFromText(text, "app.js");
  assert.equal(find(eps, "ANY", "/").handler, "", "arrow handler → no invented name");
  assert.equal(find(eps, "GET", "/ping").handler, "", "inline arrow in an object route → no name");
  assert.equal(find(eps, "GET", "/schema").handler, "getSchema", "a real handler reference still resolves");
});

test("detectEndpoints: {id} doc route and :id real route collapse to ONE, real handler wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "eps-"));
  try {
    writeFileSync(join(dir, "app.js"), `export const buildRoutes = () => ({
      '/edgeAnalytics/dashboard/:id': { GET: dashboardHandlers.getDashboard },
    });`);
    writeFileSync(join(dir, "dashboard.openapi.js"), `const paths = {
      '/edgeAnalytics/dashboard/{id}': { get: operation({ operationId: 'getDashboard', responses: {} }) },
    };`);
    const eps = detectEndpoints(dir, [{ path: "app.js" }, { path: "dashboard.openapi.js" }]);
    const dash = eps.filter((e) => e.path.includes("/dashboard/") && e.method === "GET");
    assert.equal(dash.length, 1, "the doc route and the real route are deduped to one");
    assert.equal(dash[0].path, "/edgeAnalytics/dashboard/:id", ":param display kept over {param}");
    assert.equal(dash[0].handler, "getDashboard", "the resolvable handler wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("endpoints: Next App Router derives filesystem paths, methods and dynamic segments", () => {
  const file = "web/app/(dashboard)/api/items/[id]/route.ts";
  const text = `export async function GET() { return Response.json({}) }\nconst create = async () => new Response();\nconst DELETE = create;\nexport { create as POST, DELETE }`;
  assert.equal(nextRoutePath(file), "/api/items/:id");
  const eps = extractEndpointsFromText(text, file);
  assert.equal(find(eps, "GET", "/api/items/:id").handler, "GET");
  assert.equal(find(eps, "POST", "/api/items/:id").handler, "create");
  assert.equal(find(eps, "DELETE", "/api/items/:id").handler, "DELETE");
  assert.equal(extractEndpointsFromText("const get = handler; export { get }", file).length, 0, "lowercase exports are not Next HTTP methods");
  assert.equal(nextRoutePath("src/app/docs/[...slug]/route.ts"), "/docs/*slug");
  assert.equal(nextRoutePath("src/app/search/[[...parts]]/route.ts"), "/search/*parts?");
});
