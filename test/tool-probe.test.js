// tool-probe — external-tool availability for the Settings tab. The pure half (evaluateProbe /
// firstFoundPath) is tested hermetically with an injected `exists`; probeTools is only checked for
// its shape + 60s cache contract (same result object back, no re-probe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProbe, firstFoundPath, probeTools } from "../src/tools/tool-probe.js";

test("tool-probe: firstFoundPath takes the first non-empty line of where/which output", () => {
  assert.equal(firstFoundPath("C:\\tools\\rg.exe\r\nC:\\other\\rg.exe\r\n"), "C:\\tools\\rg.exe");
  assert.equal(firstFoundPath("\n  /usr/bin/npx  \n"), "/usr/bin/npx");
  assert.equal(firstFoundPath(""), "");
  assert.equal(firstFoundPath(null), "");
});

test("tool-probe: everything found → all ok with the located paths as detail", () => {
  const r = evaluateProbe({
    rgOnPath: "C:\\tools\\rg.exe",
    npxOnPath: "C:\\nodejs\\npx.cmd",
    exists: () => false,
  });
  assert.deepEqual(r.rg, { ok: true, detail: "C:\\tools\\rg.exe" });
  assert.deepEqual(r.npx, { ok: true, detail: "C:\\nodejs\\npx.cmd" });
});

test("tool-probe: nothing found → all not-ok with human-readable details", () => {
  const r = evaluateProbe({ exists: () => false });
  assert.equal(r.rg.ok, false);
  assert.match(r.rg.detail, /rg not found/);
  assert.equal(r.npx.ok, false);
  assert.match(r.npx.detail, /npx not found/);
});

test("tool-probe: a custom rgPath that exists satisfies rg even without PATH rg", () => {
  const r = evaluateProbe({ rgPath: "D:\\bin\\rg.exe", exists: (p) => p === "D:\\bin\\rg.exe" });
  assert.equal(r.rg.ok, true);
  assert.match(r.rg.detail, /custom path/);
  // …but a custom path that does NOT exist is ignored (falls back to the PATH answer)
  assert.equal(evaluateProbe({ rgPath: "D:\\gone\\rg.exe", exists: () => false }).rg.ok, false);
});

test("tool-probe: probeTools returns the full shape and caches (same object back)", async () => {
  const first = await probeTools({ rgPath: "" });
  for (const key of ["rg", "npx"]) {
    assert.equal(typeof first[key].ok, "boolean");
    assert.equal(typeof first[key].detail, "string");
  }
  const second = await probeTools({ rgPath: "" });
  assert.equal(second, first); // 60s cache hit — no re-probe, identical result object
});
