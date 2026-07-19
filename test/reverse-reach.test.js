import test from "node:test";
import assert from "node:assert/strict";
import { reverseReach } from "../src/mcp/graph/reverse-reach.mjs";

test("reverse reach preserves runtime and compile-time provenance", () => {
  const graph = {
    inn: new Map([
      ["target", [
        { id: "runtime-parent", relation: "imports", provenance: "EXACT_LSP" },
        { id: "type-parent", relation: "imports", provenance: "RESOLVED", typeOnly: true },
      ]],
      ["type-parent", [{ id: "type-grandparent", relation: "calls", provenance: "INFERRED" }]],
    ]),
  };
  const reached = reverseReach(graph, new Set(["target"]), 2);
  assert.equal(reached.get("runtime-parent").provenance, "EXACT_LSP");
  assert.equal(reached.get("runtime-parent").compileOnly, false);
  assert.equal(reached.get("type-parent").provenance, "RESOLVED");
  assert.equal(reached.get("type-parent").compileOnly, true);
  assert.equal(reached.get("type-grandparent").compileProvenance, "INFERRED");
  assert.equal(reached.get("type-grandparent").compileDepth, 2);
});
