import test from "node:test";
import assert from "node:assert/strict";
import { computeLocalSymbolRefs, countLocalRefsOutsideOwnRange } from "../src/analysis/graph-analysis.refs.js";

test("batched local symbol reference counting preserves the per-symbol result", () => {
  const text = [
    "export function alpha() {",
    "  return alphaInner + beta();",
    "}",
    "const alphaInner = alpha();",
    "export function beta() { return 1; }",
    "const result = alpha() + beta();",
  ].join("\n");
  const symbols = [
    {id: "alpha", name: "alpha", startLine: 1, endLine: 3},
    {id: "beta", name: "beta", startLine: 5, endLine: 5},
    {id: "alphaInner", name: "alphaInner", startLine: 4, endLine: 4},
  ];
  const batched = computeLocalSymbolRefs(text, symbols);
  for (const symbol of symbols) {
    assert.equal(
      batched.get(symbol.id) || 0,
      countLocalRefsOutsideOwnRange(text, symbol.name, symbol.startLine, symbol.endLine),
      symbol.id,
    );
  }
});

test("batched local symbol reference counting handles many symbols without rescanning the file", () => {
  const symbols = Array.from({length: 2_000}, (_, index) => ({
    id: `symbol-${index}`,
    name: `symbol${index}`,
    startLine: index + 1,
    endLine: index + 1,
  }));
  const text = symbols.map((symbol, index) => `const ${symbol.name} = ${index};`).join("\n") + "\nconsole.log(symbol1999);";
  const refs = computeLocalSymbolRefs(text, symbols);
  assert.equal(refs.get("symbol-1999"), 1);
  assert.equal(refs.has("symbol-0"), false);
});
