import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClaudeModel, resolveCodexModel, winQuote } from "../src/process.js";
import { CLAUDE_MODEL } from "../src/config.js";

test("resolveClaudeModel: accepts known models case-insensitively", () => {
  assert.equal(resolveClaudeModel("opus"), "opus");
  assert.equal(resolveClaudeModel("OPUS"), "opus");
  assert.equal(resolveClaudeModel("fable"), "fable");
});

test("resolveClaudeModel: falls back to the configured default for unknown/empty input", () => {
  assert.equal(resolveClaudeModel("not-a-model"), CLAUDE_MODEL);
  assert.equal(resolveClaudeModel(""), CLAUDE_MODEL);
  assert.equal(resolveClaudeModel(undefined), CLAUDE_MODEL);
});

test("resolveCodexModel: accepts known models, rejects everything else with ''", () => {
  assert.equal(resolveCodexModel("gpt-5.5"), "gpt-5.5");
  assert.equal(resolveCodexModel("o3"), "o3");
  assert.equal(resolveCodexModel("nope"), "");
  assert.equal(resolveCodexModel(""), "");
});

// winQuote feeds the Windows shell:true command line — its job is to neutralise shell
// metacharacters in repo paths so they can't break out into a second command.
test("winQuote: leaves metachar-free values bare", () => {
  assert.equal(winQuote("claude"), "claude");
  assert.equal(winQuote("C:\\Tools\\codex.exe"), "C:\\Tools\\codex.exe");
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
