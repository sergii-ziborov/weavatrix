import { test } from "node:test";
import assert from "node:assert/strict";
import { unique, stripQuotes } from "../src/util.js";

test("unique: dedupes, trims, and drops falsy/empty values", () => {
  assert.deepEqual(unique(["a", " a ", "b", null, undefined, "", "  ", "b"]), ["a", "b"]);
});

test("unique: returns [] for no/garbage input", () => {
  assert.deepEqual(unique(), []);
  assert.deepEqual(unique([false, 0, "", null]), []);
});

test("unique: coerces non-strings then trims", () => {
  assert.deepEqual(unique([1, " 1 ", 2]), ["1", "2"]);
});

test("stripQuotes: removes a single surrounding double- or single-quote pair", () => {
  assert.equal(stripQuotes('"x"'), "x");
  assert.equal(stripQuotes("'y'"), "y");
});

test("stripQuotes: trims surrounding whitespace before stripping", () => {
  assert.equal(stripQuotes('  "z"  '), "z");
});

test("stripQuotes: leaves unquoted values untouched and tolerates empty input", () => {
  assert.equal(stripQuotes("plain"), "plain");
  assert.equal(stripQuotes(), "");
});
