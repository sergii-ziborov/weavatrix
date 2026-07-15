// AST-backed, language-aware source complexity summary.
//
// This intentionally reports LOCAL algorithmic work separately from calls/I/O. A method with no loop
// can be O(1) locally while its end-to-end latency remains callee-bound; object/array spreads are linear
// shallow copies even without an explicit loop. Reports are plain JSON and are persisted on graph nodes,
// so the renderer never needs a second implementation of the algorithm.
//
// Implementation lives in the sibling modules:
//   source-complexity.constants.js — node-type and call-name tables
//   source-complexity.ast.js       — tree-sitter node helpers
//   source-complexity.report.js    — rank/label/evidence builders
//   source-complexity.walk.js      — the syntax walk and summary assembly

export { analyzeSyntaxComplexity } from "./source-complexity.walk.js";
