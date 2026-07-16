import test from "node:test";
import assert from "node:assert/strict";
import { createStalenessNoticeGate } from "../src/mcp/staleness-notice.mjs";

test("identical stale warnings are throttled but changed state and graph_stats remain visible", () => {
  const gate = createStalenessNoticeGate(1_000);
  const base = { line: "Warning: one dirty file", graphPath: "graph.json" };
  assert.equal(gate.shouldShow({ ...base, now: 10 }), true);
  assert.equal(gate.shouldShow({ ...base, now: 20 }), false);
  assert.equal(gate.shouldShow({ ...base, now: 21, force: true }), true);
  assert.equal(gate.shouldShow({ ...base, line: "Warning: two dirty files", now: 22 }), true);
  assert.equal(gate.shouldShow({ ...base, line: "Warning: two dirty files", now: 1_023 }), true);
});
