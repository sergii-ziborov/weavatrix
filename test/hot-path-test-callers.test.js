import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHotPathReview } from "../src/analysis/hot-path-review.js";

// A production symbol exercised by inline #[test] callers (and by test-path files) must not have those
// callers counted as production coupling: inline tests inflating fan-in is the same "tests make production
// look hot" defect the diff removes from coverage and duplicates.
const HOT = {
  startLine: 1, endLine: 12, timeRank: 3, timeLabel: "O(n^2) local — nested iteration",
  timeScore: 0.6, memoryRank: 1, memoryLabel: "O(n) auxiliary", memoryScore: 0.3,
  cyclomatic: 4, callCount: 3, loops: 2, maxLoopDepth: 2,
  allocationsInLoops: 1, copiesInLoops: 0, linearOpsInLoops: 1, sortsInLoops: 0, recursionInLoops: 0,
  recursion: false, hotEvidence: [{ kind: "allocation-in-loop", line: 4 }],
};

function graph() {
  return {
    complexityV: 2,
    nodes: [
      { id: "src/parse.rs#parse_frame@1", source_file: "src/parse.rs", symbol_kind: "function", complexity: HOT },
      { id: "src/parse.rs#tests@20", source_file: "src/parse.rs", symbol_kind: "module", test_surface: true },
      { id: "src/parse.rs#t1@22", source_file: "src/parse.rs", symbol_kind: "function", test_surface: true },
      { id: "src/parse.rs#t2@24", source_file: "src/parse.rs", symbol_kind: "function", test_surface: true },
      { id: "test/frame_spec.rs#it_parses@1", source_file: "test/frame_spec.rs", symbol_kind: "function" },
      { id: "src/decode.rs#decode@1", source_file: "src/decode.rs", symbol_kind: "function" },
    ],
    links: [
      { source: "src/parse.rs#t1@22", target: "src/parse.rs#parse_frame@1", relation: "calls" },
      { source: "src/parse.rs#t2@24", target: "src/parse.rs#parse_frame@1", relation: "calls" },
      { source: "test/frame_spec.rs#it_parses@1", target: "src/parse.rs#parse_frame@1", relation: "calls" },
      // the only genuine PRODUCTION caller
      { source: "src/decode.rs#decode@1", target: "src/parse.rs#parse_frame@1", relation: "calls" },
    ],
  };
}

test("hot_path_review: inline-test and test-path callers are excluded from a production symbol's fan-in", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "wx-hot-tc-"));
  try {
    const def = computeHotPathReview(graph(), { repoRoot, minScore: 0 });
    const defHot = def.hotspots.find((h) => h.id === "src/parse.rs#parse_frame@1");
    assert.ok(defHot, "the production fn surfaces at min_score 0");
    assert.equal(defHot.graphRisk.fanIn, 1, "only the production caller counts; the two inline #[test] fns and the test-path caller are excluded");

    const incl = computeHotPathReview(graph(), { repoRoot, minScore: 0, includeTests: true });
    const inclHot = incl.hotspots.find((h) => h.id === "src/parse.rs#parse_frame@1");
    assert.equal(inclHot.graphRisk.fanIn, 4, "include_tests restores all callers: the production caller plus 2 inline #[test] fns and 1 test-path caller");
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});
