import test from "node:test";
import assert from "node:assert/strict";
import { resolveExePath } from "../src/tools/command-availability.js";

// Direct-exe resolution exists because EDR/AV heuristics can block cmd.exe shell spawns with long,
// URL-ish command lines (bun + 30 test paths → spawn EPERM) — see runCoverage.
test("resolveExePath: real exe on PATH resolves; shims/unknowns/explicit paths return ''", { skip: process.platform !== "win32" }, async () => {
  assert.match(await resolveExePath("node"), /\.exe$/i, "node resolves to its real .exe");
  assert.equal(await resolveExePath("definitely-not-a-command-xyz"), "");
  assert.equal(await resolveExePath("node.exe"), "", "already-.exe input is left to the caller");
  assert.equal(await resolveExePath("some/relative/path"), "", "explicit paths are left as written");
  assert.equal(await resolveExePath(""), "");
});
