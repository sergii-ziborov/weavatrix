import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeGitHistory,
  buildGitHistoryAnalytics,
  formatGitHistoryAnalytics,
  parseGitNumstatLog,
} from "../src/analysis/git-history.js";

const hash = (char) => char.repeat(40);
const commit = (id, timestamp, stats) => `\x1e${id}\x1f${timestamp}\0\n${stats.join("\0")}\0`;
const stat = (added, deleted, path) => `${added}\t${deleted}\t${path}`;

test("git history parser handles numstat, binary files, renames and an atomic change-set cap", () => {
  const raw = commit(hash("a"), 100, [
    stat(10, 2, "src/a.js"),
    stat("-", "-", "assets/a.png"),
    "3\t1\t", "src/old.js", "src/new.js",
  ]) + commit(hash("b"), 90, [
    stat(1, 0, "src/one.js"),
    stat(1, 0, "src/two.js"),
    stat(1, 0, "src/three.js"),
    stat(1, 0, "src/four.js"),
  ]);
  const commits = parseGitNumstatLog(raw, { maxFilesPerCommit: 3 });
  assert.deepEqual(commits[0].files, [
    { file: "assets/a.png", additions: 0, deletions: 0, binary: true },
    { file: "src/a.js", additions: 10, deletions: 2, binary: false },
    { file: "src/new.js", additions: 3, deletions: 1, binary: false, renamedFrom: "src/old.js" },
  ]);
  assert.equal(commits[1].oversized, true);
  assert.equal(commits[1].fileCount, 4);
  assert.deepEqual(commits[1].files, [], "a large commit is excluded, never analyzed as a truncated prefix");
});

const graph = {
  nodes: [
    { id: "a", source_file: "src/a.js" },
    { id: "b", source_file: "src/b.js" },
    { id: "c", source_file: "src/c.js" },
    { id: "d", source_file: "src/d.js" },
    { id: "t", source_file: "test/a.test.js" },
  ],
  links: [
    { source: "a", target: "b", relation: "imports" },
    { source: "b", target: "c", relation: "imports" },
    { source: "t", target: "a", relation: "imports" },
  ],
};

function parsedCommit(id, files) {
  return {
    hash: hash(id), timestamp: 1, fileCount: files.length, ignoredFiles: 0, invalidPaths: 0, oversized: false,
    files: files.map((file, index) => ({ file, additions: index + 1, deletions: 1, binary: false })),
  };
}

test("history analytics combines raw churn/connectivity and separates expected from hidden coupling", () => {
  const result = buildGitHistoryAnalytics({
    commits: [
      parsedCommit("a", ["src/a.js", "src/b.js", "test/a.test.js"]),
      parsedCommit("b", ["src/a.js", "src/b.js", "test/a.test.js"]),
      parsedCommit("c", ["src/a.js", "src/c.js", "src/d.js"]),
      parsedCommit("d", ["src/a.js", "src/c.js", "src/d.js"]),
      parsedCommit("e", ["src/b.js"]),
    ],
    graph,
    window: { months: 6, since: "2026-01-01T00:00:00.000Z", until: "2026-07-01T00:00:00.000Z" },
    limits: { maxCommits: 50, maxFilesPerCommit: 20, maxPairs: 50, minPairCount: 2, maxPairCandidates: 1000 },
  });

  const hidden = result.coupling.hidden.find((pair) => pair.left === "src/a.js" && pair.right === "src/d.js");
  assert.deepEqual(hidden, {
    left: "src/a.js", right: "src/d.js", count: 2, jaccard: 0.5, lift: 1.25,
    confidence: 1, leftConfidence: 0.5, rightConfidence: 1, graphDistance: null,
  });
  assert.ok(!result.coupling.hidden.some((pair) => pair.left === "src/a.js" && pair.right === "src/c.js"), "a two-hop graph path is not hidden coupling");
  assert.ok(!result.coupling.hidden.some((pair) => pair.left.includes("test/") || pair.right.includes("test/")), "test pairs never leak into hidden production coupling");
  assert.ok(result.coupling.expectedTestSource.some((pair) => pair.test === "test/a.test.js" && pair.source === "src/a.js"));
  assert.equal(result.fileChurn.find((file) => file.file === "src/a.js").commits, 4);
  assert.ok(result.hotspots[0].hotspotScore >= result.hotspots[1].hotspotScore);
});

test("analyzeGitHistory invokes bounded no-merge numstat log, strips hosted token and respects .weavatrixignore", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wx-history-"));
  writeFileSync(join(repo, ".weavatrixignore"), "generated/**\n");
  const previousToken = process.env.WEAVATRIX_SYNC_TOKEN;
  process.env.WEAVATRIX_SYNC_TOKEN = "must-not-reach-git";
  let invocation;
  try {
    const result = await analyzeGitHistory({
      repoRoot: repo,
      graph,
      months: 3,
      maxCommits: 10,
      maxFilesPerCommit: 10,
      now: "2026-07-16T12:00:00.000Z",
      runner: async (command, args, options) => {
        invocation = { command, args, options };
        return {
          exitCode: 0,
          truncated: false,
          stderr: "",
          stdout: commit(hash("f"), 100, [stat(4, 1, "src/a.js"), stat(99, 0, "generated/client.js")]),
        };
      },
    });
    assert.equal(invocation.command, "git");
    assert.ok(invocation.args.includes("--no-merges"));
    assert.ok(invocation.args.includes("--numstat"));
    assert.ok(invocation.args.includes("-z"));
    assert.ok(invocation.args.includes("--max-count=11"));
    assert.ok(invocation.args.includes("--since=2026-04-16T12:00:00.000Z"));
    assert.equal(invocation.options.env.WEAVATRIX_SYNC_TOKEN, undefined);
    assert.deepEqual(result.fileChurn.map((entry) => entry.file), ["src/a.js"]);
    assert.equal(result.totals.ignoredFiles, 1);
  } finally {
    if (previousToken === undefined) delete process.env.WEAVATRIX_SYNC_TOKEN;
    else process.env.WEAVATRIX_SYNC_TOKEN = previousToken;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("history bounds and formatter are explicit and deterministic", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wx-history-limit-"));
  try {
    await assert.rejects(() => analyzeGitHistory({ repoRoot: repo, months: 4, runner: async () => ({}) }), /3, 6 or 12/);
    const result = buildGitHistoryAnalytics({
      commits: [parsedCommit("a", ["src/a.js", "src/d.js"]), { ...parsedCommit("b", ["src/a.js"]), oversized: true, files: [] }],
      graph,
      window: { months: 6, since: "2026-01-01T00:00:00.000Z", until: "2026-07-01T00:00:00.000Z" },
      limits: { maxCommits: 2, maxFilesPerCommit: 2, maxPairs: 10, minPairCount: 1, maxPairCandidates: 100 },
    });
    assert.equal(result.status, "partial");
    assert.match(result.completeness.reasons[0], /oversized/);
    const formatted = formatGitHistoryAnalytics(result, { topN: 5 });
    assert.match(formatted, /^Git history intelligence — 6 months/);
    assert.match(formatted, /Hidden co-change coupling \(no graph path within 2 hops\):/);
    assert.match(formatted, /src\/a\.js ↔ src\/d\.js/);
    assert.equal(formatted, formatGitHistoryAnalytics(result, { topN: 5 }));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
