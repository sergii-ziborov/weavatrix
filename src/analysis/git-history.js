// Bounded behavioral analysis over local Git history. The collector never reads source bodies:
// it asks Git for numstat metadata, applies repository-local exclusions, then combines raw churn
// with the existing file graph. Large commits are deliberately excluded rather than truncated so
// mass formatting/generated-code updates cannot manufacture co-change evidence.
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { childProcessEnv } from "../child-env.js";
import { isTestPath } from "../graph/graph-filter.js";
import { isStructuralRelation } from "../graph/relations.js";
import { createRepoBoundary } from "../repo-path.js";
import { isWeavatrixIgnored, loadWeavatrixIgnore } from "../path-ignore.js";

export const GIT_HISTORY_V = 1;
export const GIT_HISTORY_WINDOWS = Object.freeze([3, 6, 12]);

const DEFAULTS = Object.freeze({
  months: 6,
  maxCommits: 500,
  maxFilesPerCommit: 80,
  maxPairs: 100,
  minPairCount: 2,
  maxPairCandidates: 100_000,
  maxOutputBytes: 16 * 1024 * 1024,
  timeoutMs: 20_000,
});
const HARD_CAPS = Object.freeze({
  maxCommits: 2_000,
  maxFilesPerCommit: 200,
  maxPairs: 500,
  maxPairCandidates: 250_000,
  maxOutputBytes: 64 * 1024 * 1024,
  timeoutMs: 60_000,
});
const HEADER_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const GIT_FORMAT = "%x1e%H%x1f%ct";

const endpoint = (value) => value && typeof value === "object" ? value.id : value;
const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const boundedInteger = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const normalizePath = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");

function safeHistoryPath(value) {
  const path = normalizePath(value);
  if (!path || path.includes("\0") || isAbsolute(path) || /^[a-z]:\//i.test(path)) return null;
  if (/[\x00-\x1f\x7f]/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

function utcMonthsBefore(date, months) {
  const source = new Date(date);
  if (!Number.isFinite(source.getTime())) throw new Error("now must be a valid date");
  const targetMonth = source.getUTCMonth() - months;
  const first = new Date(Date.UTC(source.getUTCFullYear(), targetMonth, 1, source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return first;
}

function normalizeOptions(input = {}) {
  const months = Number(input.months ?? DEFAULTS.months);
  if (!GIT_HISTORY_WINDOWS.includes(months)) throw new Error("months must be one of 3, 6 or 12");
  return {
    months,
    maxCommits: boundedInteger(input.maxCommits, DEFAULTS.maxCommits, 1, HARD_CAPS.maxCommits),
    maxFilesPerCommit: boundedInteger(input.maxFilesPerCommit, DEFAULTS.maxFilesPerCommit, 2, HARD_CAPS.maxFilesPerCommit),
    maxPairs: boundedInteger(input.maxPairs, DEFAULTS.maxPairs, 1, HARD_CAPS.maxPairs),
    minPairCount: boundedInteger(input.minPairCount, DEFAULTS.minPairCount, 1, 100),
    maxPairCandidates: boundedInteger(input.maxPairCandidates, DEFAULTS.maxPairCandidates, 100, HARD_CAPS.maxPairCandidates),
    maxOutputBytes: boundedInteger(input.maxOutputBytes, DEFAULTS.maxOutputBytes, 64 * 1024, HARD_CAPS.maxOutputBytes),
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULTS.timeoutMs, 1_000, HARD_CAPS.timeoutMs),
  };
}

function boundedGitCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const stop = () => {
      try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (truncated) return;
      const remaining = options.maxOutputBytes - stdoutBytes;
      if (remaining <= 0) {
        truncated = true;
        stop();
        return;
      }
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stdout.push(kept);
      stdoutBytes += kept.length;
      if (kept.length !== chunk.length) {
        truncated = true;
        stop();
      }
    });
    child.stderr?.on("data", (chunk) => {
      const remaining = 64 * 1024 - stderrBytes;
      if (remaining <= 0) return;
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) => finish(() => {
      if (timedOut) return reject(new Error("git history collection timed out"));
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: Number(exitCode ?? 1),
        truncated,
      });
    }));
  });
}

function statNumber(value) {
  return value === "-" ? { value: 0, binary: true } : { value: Number(value), binary: false };
}

// Parse the NUL-delimited output produced by `git log --no-merges --numstat -z`.
// The destination path is used for a rename. A change-set over the cap is marked oversized and its
// partial file list is discarded so downstream metrics are never based on a misleading prefix.
export function parseGitNumstatLog(raw, options = {}) {
  const maxFilesPerCommit = boundedInteger(options.maxFilesPerCommit, DEFAULTS.maxFilesPerCommit, 2, HARD_CAPS.maxFilesPerCommit);
  const ignoreRules = options.ignoreRules || [];
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  const segments = text.split(HEADER_SEPARATOR).slice(1);
  if (options.dropLastIncomplete && segments.length) segments.pop();
  const commits = [];

  for (const segment of segments) {
    const firstNul = segment.indexOf("\0");
    if (firstNul < 0) continue;
    const header = segment.slice(0, firstNul).replace(/^[\r\n]+/, "");
    const separator = header.indexOf(FIELD_SEPARATOR);
    if (separator < 0) continue;
    const hash = header.slice(0, separator);
    const timestamp = Number(header.slice(separator + 1));
    if (!/^[a-f0-9]{40,64}$/i.test(hash) || !Number.isInteger(timestamp) || timestamp < 0) continue;

    const tokens = segment.slice(firstNul + 1).split("\0");
    const files = new Map();
    let fileCount = 0;
    let ignoredFiles = 0;
    let invalidPaths = 0;
    let oversized = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index].replace(/^[\r\n]+/, "");
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
      if (!match) continue;
      let rawPath = match[3];
      let renamedFrom = null;
      if (!rawPath) {
        renamedFrom = safeHistoryPath(tokens[index + 1]);
        rawPath = tokens[index + 2];
        index += 2;
      }
      const path = safeHistoryPath(rawPath);
      if (!path) {
        invalidPaths += 1;
        continue;
      }
      if (isWeavatrixIgnored(path, ignoreRules)) {
        ignoredFiles += 1;
        continue;
      }
      const additions = statNumber(match[1]);
      const deletions = statNumber(match[2]);
      fileCount += 1;
      if (fileCount > maxFilesPerCommit) {
        oversized = true;
        files.clear();
        continue;
      }
      if (oversized) continue;
      const previous = files.get(path);
      files.set(path, {
        file: path,
        additions: (previous?.additions || 0) + additions.value,
        deletions: (previous?.deletions || 0) + deletions.value,
        binary: Boolean(previous?.binary || additions.binary || deletions.binary),
        ...(renamedFrom ? { renamedFrom } : previous?.renamedFrom ? { renamedFrom: previous.renamedFrom } : {}),
      });
    }
    commits.push({
      hash,
      timestamp,
      fileCount,
      ignoredFiles,
      invalidPaths,
      oversized,
      files: oversized ? [] : [...files.values()].sort((left, right) => left.file.localeCompare(right.file)),
    });
  }
  return commits;
}

function graphFilesAndAdjacency(graph = {}) {
  const byId = new Map();
  const files = new Set();
  for (const node of graph.nodes || []) {
    const file = safeHistoryPath(node?.source_file);
    if (!file) continue;
    byId.set(String(node.id), file);
    files.add(file);
  }
  const adjacency = new Map([...files].map((file) => [file, new Set()]));
  for (const link of graph.links || []) {
    if (isStructuralRelation(link?.relation) || link?.barrelProxy === true) continue;
    const left = byId.get(String(endpoint(link?.source)));
    const right = byId.get(String(endpoint(link?.target)));
    if (!left || !right || left === right) continue;
    adjacency.get(left)?.add(right);
    adjacency.get(right)?.add(left);
  }
  return { files, adjacency };
}

function graphDistanceAtMostTwo(left, right, adjacency) {
  if (left === right) return 0;
  const neighbors = adjacency.get(left);
  if (!neighbors) return null;
  if (neighbors.has(right)) return 1;
  for (const middle of neighbors) if (adjacency.get(middle)?.has(right)) return 2;
  return null;
}

function percentile(value, positiveValues) {
  if (!(value > 0) || !positiveValues.length) return 0;
  let atOrBelow = 0;
  for (const candidate of positiveValues) if (candidate <= value) atOrBelow += 1;
  return round(atOrBelow / positiveValues.length);
}

function pairSort(left, right) {
  return right.count - left.count
    || right.confidence - left.confidence
    || right.lift - left.lift
    || left.left.localeCompare(right.left)
    || left.right.localeCompare(right.right);
}

function publicPair(pair, graphDistance) {
  return {
    left: pair.left,
    right: pair.right,
    count: pair.count,
    jaccard: pair.jaccard,
    lift: pair.lift,
    confidence: pair.confidence,
    leftConfidence: pair.leftConfidence,
    rightConfidence: pair.rightConfidence,
    graphDistance,
  };
}

// Pure deterministic reducer for tests and for future hosted evidence snapshots.
export function buildGitHistoryAnalytics({ commits = [], graph = {}, window, limits = {}, status = "complete" } = {}) {
  const maxPairs = boundedInteger(limits.maxPairs, DEFAULTS.maxPairs, 1, HARD_CAPS.maxPairs);
  const minPairCount = boundedInteger(limits.minPairCount, DEFAULTS.minPairCount, 1, 100);
  const maxPairCandidates = boundedInteger(limits.maxPairCandidates, DEFAULTS.maxPairCandidates, 100, HARD_CAPS.maxPairCandidates);
  const eligible = commits.filter((commit) => !commit.oversized && commit.files.length > 0);
  const skipped = commits.filter((commit) => commit.oversized);
  const activity = new Map();
  const fileCommits = new Map();
  let additions = 0;
  let deletions = 0;
  let binaryChanges = 0;

  for (const commit of eligible) {
    const seen = new Set();
    for (const stat of commit.files) {
      if (seen.has(stat.file)) continue;
      seen.add(stat.file);
      const entry = activity.get(stat.file) || { file: stat.file, commits: 0, additions: 0, deletions: 0, binaryChanges: 0 };
      entry.commits += 1;
      entry.additions += stat.additions;
      entry.deletions += stat.deletions;
      entry.binaryChanges += stat.binary ? 1 : 0;
      activity.set(stat.file, entry);
      fileCommits.set(stat.file, (fileCommits.get(stat.file) || 0) + 1);
      additions += stat.additions;
      deletions += stat.deletions;
      if (stat.binary) binaryChanges += 1;
    }
  }

  const { files: graphFiles, adjacency } = graphFilesAndAdjacency(graph);
  const raw = [...activity.values()].map((entry) => ({ ...entry, churn: entry.additions + entry.deletions }));
  const churnValues = raw.map((entry) => entry.churn).filter((value) => value > 0);
  const connectivityValues = [...graphFiles].map((file) => adjacency.get(file)?.size || 0).filter((value) => value > 0);
  const fileChurn = raw.map((entry) => {
    const connectivity = adjacency.get(entry.file)?.size || 0;
    const churnPercentile = percentile(entry.churn, churnValues);
    const connectivityPercentile = percentile(connectivity, connectivityValues);
    return {
      ...entry,
      connectivity,
      churnPercentile,
      connectivityPercentile,
      hotspotScore: round(Math.sqrt(churnPercentile * connectivityPercentile)),
    };
  }).sort((left, right) => right.churn - left.churn || right.commits - left.commits || left.file.localeCompare(right.file));
  const hotspots = fileChurn.filter((entry) => entry.connectivity > 0)
    .sort((left, right) => right.hotspotScore - left.hotspotScore || right.churn - left.churn || right.connectivity - left.connectivity || left.file.localeCompare(right.file));

  const pairCounts = new Map();
  let pairCandidatesTruncated = false;
  for (const commit of eligible) {
    const files = [...new Set(commit.files.map((entry) => entry.file))].sort();
    for (let leftIndex = 0; leftIndex < files.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < files.length; rightIndex += 1) {
        const key = `${files[leftIndex]}\0${files[rightIndex]}`;
        if (!pairCounts.has(key) && pairCounts.size >= maxPairCandidates) {
          pairCandidatesTruncated = true;
          continue;
        }
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const denominator = eligible.length;
  const pairs = [];
  for (const [key, count] of pairCounts) {
    if (count < minPairCount || denominator === 0) continue;
    const split = key.indexOf("\0");
    const left = key.slice(0, split);
    const right = key.slice(split + 1);
    const leftCount = fileCommits.get(left) || 0;
    const rightCount = fileCommits.get(right) || 0;
    const leftConfidence = count / leftCount;
    const rightConfidence = count / rightCount;
    pairs.push({
      left,
      right,
      count,
      jaccard: round(count / (leftCount + rightCount - count)),
      lift: round((count * denominator) / (leftCount * rightCount)),
      confidence: round(Math.max(leftConfidence, rightConfidence)),
      leftConfidence: round(leftConfidence),
      rightConfidence: round(rightConfidence),
    });
  }
  pairs.sort(pairSort);

  const observed = pairs.slice(0, maxPairs).map((pair) => publicPair(pair, graphDistanceAtMostTwo(pair.left, pair.right, adjacency)));
  const expectedTestSource = pairs.filter((pair) => isTestPath(pair.left) !== isTestPath(pair.right)).slice(0, maxPairs).map((pair) => {
    const test = isTestPath(pair.left) ? pair.left : pair.right;
    const source = test === pair.left ? pair.right : pair.left;
    return {
      source,
      test,
      count: pair.count,
      jaccard: pair.jaccard,
      lift: pair.lift,
      confidence: pair.confidence,
      sourceConfidence: source === pair.left ? pair.leftConfidence : pair.rightConfidence,
      testConfidence: test === pair.left ? pair.leftConfidence : pair.rightConfidence,
      graphDistance: graphDistanceAtMostTwo(source, test, adjacency),
    };
  });
  const hidden = pairs.filter((pair) => {
    if (isTestPath(pair.left) || isTestPath(pair.right)) return false;
    if (!graphFiles.has(pair.left) || !graphFiles.has(pair.right)) return false;
    return graphDistanceAtMostTwo(pair.left, pair.right, adjacency) === null;
  }).slice(0, maxPairs).map((pair) => publicPair(pair, null));

  const ignoredFiles = commits.reduce((sum, commit) => sum + (commit.ignoredFiles || 0), 0);
  const invalidPaths = commits.reduce((sum, commit) => sum + (commit.invalidPaths || 0), 0);
  const completenessReasons = [
    skipped.length ? `${skipped.length} oversized change-set(s) excluded` : null,
    pairCandidatesTruncated ? "co-change candidate cap reached" : null,
    status === "partial" ? "git output or commit window was truncated" : null,
  ].filter(Boolean);
  return {
    gitHistoryV: GIT_HISTORY_V,
    status: completenessReasons.length ? "partial" : status,
    window: window || null,
    limits: {
      maxCommits: limits.maxCommits ?? null,
      maxFilesPerCommit: limits.maxFilesPerCommit ?? null,
      maxPairs,
      minPairCount,
      maxPairCandidates,
    },
    completeness: { complete: completenessReasons.length === 0, reasons: completenessReasons },
    totals: {
      commitsRead: commits.length,
      commitsAnalyzed: eligible.length,
      oversizedCommitsSkipped: skipped.length,
      files: fileChurn.length,
      additions,
      deletions,
      churn: additions + deletions,
      binaryChanges,
      ignoredFiles,
      invalidPaths,
      graphFiles: graphFiles.size,
    },
    fileChurn,
    hotspots,
    coupling: {
      eligibleCommits: denominator,
      totalCandidates: pairCounts.size,
      candidatesTruncated: pairCandidatesTruncated,
      observed,
      expectedTestSource,
      hidden,
    },
  };
}

function unavailableResult(window, limits, reason) {
  return {
    gitHistoryV: GIT_HISTORY_V,
    status: "unavailable",
    window,
    limits,
    completeness: { complete: false, reasons: [reason] },
    totals: { commitsRead: 0, commitsAnalyzed: 0, oversizedCommitsSkipped: 0, files: 0, additions: 0, deletions: 0, churn: 0, binaryChanges: 0, ignoredFiles: 0, invalidPaths: 0, graphFiles: 0 },
    fileChurn: [],
    hotspots: [],
    coupling: { eligibleCommits: 0, totalCandidates: 0, candidatesTruncated: false, observed: [], expectedTestSource: [], hidden: [] },
  };
}

// Execute one local, read-only Git query and return aggregates only (no commit messages/authors/source).
export async function analyzeGitHistory(input = {}) {
  const options = normalizeOptions(input);
  const now = new Date(input.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
  const since = utcMonthsBefore(now, options.months);
  const window = { months: options.months, since: since.toISOString(), until: now.toISOString() };
  const limits = {
    maxCommits: options.maxCommits,
    maxFilesPerCommit: options.maxFilesPerCommit,
    maxPairs: options.maxPairs,
    minPairCount: options.minPairCount,
    maxPairCandidates: options.maxPairCandidates,
  };
  const boundary = createRepoBoundary(input.repoRoot);
  if (!boundary.root) return unavailableResult(window, limits, "repository root is unavailable");
  const args = [
    "log",
    "--no-merges",
    "--numstat",
    "-z",
    `--format=${GIT_FORMAT}`,
    `--since=${window.since}`,
    `--until=${window.until}`,
    `--max-count=${options.maxCommits + 1}`,
    "--",
    ".",
  ];
  const runner = input.runner || boundedGitCommand;
  let execution;
  try {
    execution = await runner("git", args, {
      cwd: boundary.root,
      env: childProcessEnv(),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
  } catch (error) {
    return unavailableResult(window, limits, String(error?.message || "git history collection failed").slice(0, 200));
  }
  if (execution.exitCode !== 0 && !execution.truncated) return unavailableResult(window, limits, "git log failed");

  const rawBuffer = Buffer.isBuffer(execution.stdout) ? execution.stdout : Buffer.from(String(execution.stdout || ""));
  const tooLarge = rawBuffer.length > options.maxOutputBytes;
  const truncated = Boolean(execution.truncated || tooLarge);
  const bounded = tooLarge ? rawBuffer.subarray(0, options.maxOutputBytes) : rawBuffer;
  const parsed = parseGitNumstatLog(bounded, {
    maxFilesPerCommit: options.maxFilesPerCommit,
    ignoreRules: loadWeavatrixIgnore(boundary.root),
    dropLastIncomplete: truncated,
  });
  const commitsTruncated = parsed.length > options.maxCommits;
  const commits = parsed.slice(0, options.maxCommits);
  return buildGitHistoryAnalytics({
    commits,
    graph: input.graph || {},
    window,
    limits,
    status: truncated || commitsTruncated ? "partial" : "complete",
  });
}

export function formatGitHistoryAnalytics(result, options = {}) {
  const topN = boundedInteger(options.topN, 10, 1, 50);
  if (!result || result.status === "unavailable") {
    const reason = result?.completeness?.reasons?.[0] || "history is unavailable";
    return `Git history intelligence: UNAVAILABLE — ${reason}`;
  }
  const window = result.window ? `${result.window.months} months (${result.window.since.slice(0, 10)} → ${result.window.until.slice(0, 10)})` : "configured window";
  const lines = [
    `Git history intelligence — ${window}`,
    `Status: ${String(result.status).toUpperCase()} · ${result.totals.commitsAnalyzed}/${result.totals.commitsRead} commits analyzed · ${result.totals.files} files · ${result.totals.churn} changed lines`,
    "",
    "Hotspots (churn percentile × graph-connectivity percentile):",
  ];
  const hotspots = result.hotspots.slice(0, topN);
  if (!hotspots.length) lines.push("- none");
  for (const item of hotspots) lines.push(`- ${item.file}: score ${item.hotspotScore.toFixed(4)} · churn ${item.churn} in ${item.commits} commits · connectivity ${item.connectivity}`);
  lines.push("", "Hidden co-change coupling (no graph path within 2 hops):");
  const hidden = result.coupling.hidden.slice(0, topN);
  if (!hidden.length) lines.push("- none");
  for (const pair of hidden) lines.push(`- ${pair.left} ↔ ${pair.right}: ${pair.count} commits · Jaccard ${pair.jaccard.toFixed(4)} · lift ${pair.lift.toFixed(4)} · confidence ${pair.confidence.toFixed(4)}`);
  lines.push("", "Expected test/source co-change:");
  const expected = result.coupling.expectedTestSource.slice(0, topN);
  if (!expected.length) lines.push("- none");
  for (const pair of expected) lines.push(`- ${pair.test} ↔ ${pair.source}: ${pair.count} commits · confidence ${pair.confidence.toFixed(4)}`);
  if (result.completeness.reasons.length) lines.push("", `Partial: ${result.completeness.reasons.join("; ")}.`);
  return lines.join("\n");
}
