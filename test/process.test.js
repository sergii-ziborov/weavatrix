import { test } from "node:test";
import assert from "node:assert/strict";
import { winQuote } from "../src/process.js";

// winQuote feeds the Windows shell:true command line — its job is to neutralise shell
// metacharacters in repo paths so they can't break out into a second command.
test("winQuote: leaves metachar-free values bare", () => {
  assert.equal(winQuote("rg"), "rg");
  assert.equal(winQuote("C:\\Tools\\rg.exe"), "C:\\Tools\\rg.exe");
});

test("winQuote: wraps values containing spaces or shell metacharacters in quotes", () => {
  assert.equal(winQuote("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
  assert.equal(winQuote("a&b"), '"a&b"');
  assert.equal(winQuote("a|b"), '"a|b"');
  assert.equal(winQuote("a`b"), '"a`b"');
  assert.equal(winQuote("a>b"), '"a>b"');
});

test("winQuote: doubles embedded double-quotes (cmd.exe escaping)", () => {
  assert.equal(winQuote('a"b'), '"a""b"');
});
