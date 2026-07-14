import { test } from "node:test";
import assert from "node:assert/strict";
import { normSegments, segMatch } from "../src/scan/apimap.js";

test("normSegments: collapses {id}, :id and ${id} param segments to '*'", () => {
  assert.deepEqual(normSegments("/api/users/{id}"), ["api", "users", "*"]);
  assert.deepEqual(normSegments("/api/users/:id"), ["api", "users", "*"]);
  assert.deepEqual(normSegments("/api/users/${id}"), ["api", "users", "*"]);
});

test("normSegments: lowercases literal segments and drops empties", () => {
  assert.deepEqual(normSegments("/API//Users/"), ["api", "users"]);
});

test("normSegments: strips query string and fragment", () => {
  assert.deepEqual(normSegments("/a/b?x=1&y=2#frag"), ["a", "b"]);
});

test("normSegments: treats mixed template segments (users-${id}) as wildcards", () => {
  assert.deepEqual(normSegments("/v1/users-${id}/posts"), ["v1", "*", "posts"]);
});

test("segMatch: equal-length literal paths match only when every segment matches", () => {
  assert.equal(segMatch(["api", "users"], ["api", "users"]), true);
  assert.equal(segMatch(["api", "users"], ["api", "orders"]), false);
});

test("segMatch: a '*' on either side matches any literal", () => {
  assert.equal(segMatch(["api", "users", "123"], ["api", "users", "*"]), true);
  assert.equal(segMatch(["api", "*"], ["api", "users"]), true);
});

test("segMatch: different lengths never match", () => {
  assert.equal(segMatch(["api", "users"], ["api", "users", "123"]), false);
});
