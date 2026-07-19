import test from "node:test";
import assert from "node:assert/strict";
import {
  extractHttpClientCallsFromText,
  matchHttpContract,
  normalizeHttpContractPath,
} from "../src/analysis/http-contracts.js";

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

test("HTTP client extraction resolves bounded local string constants in template URL prefixes", () => {
  const text = `
    const API_ROOT = 'https://example.test/edgeAnalytics';
    const QUERY_ROOT = \`\${API_ROOT}/query\`;
    apiClient.get(\`\${QUERY_ROOT}/\${id}\`);
  `;
  const result = extractHttpClientCallsFromText(text, "src/query-client.ts");
  assert.deepEqual(result.calls.map((call) => [call.method, call.path, call.unknownPrefix, call.partialDynamic]), [
    ["GET", "/edgeAnalytics/query/:param", false, false],
  ]);
});

test("configured bare and object/member wrappers use bounded URL argument positions", () => {
  const text = `
    get<User>('/api/users/42');
    transport.send<Result>({ cache: false }, '/api/items/7');
  `;
  const result = extractHttpClientCallsFromText(text, "src/custom-client.ts", {
    wrappers: [
      { call: "get", method: "GET", url_argument: 0 },
      { object: "transport", member: "send", method: "DELETE", url_argument: 1 },
    ],
  });
  assert.deepEqual(result.calls.map((call) => [call.client, call.method, call.path, call.detector]), [
    ["get", "GET", "/api/users/42", "input-wrapper"],
    ["transport.send", "DELETE", "/api/items/7", "input-wrapper"],
  ]);
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
