// Rank, score, label, and evidence builders for the source-complexity report.

function timeScore(rank) {
  return [0.2, 0.4, 0.65, 0.95, 1.3, 1.7][Math.max(0, Math.min(5, rank))] || 0.2;
}

function memoryScore(rank) {
  return [0.15, 0.35, 0.85, 1.05, 1.4, 1.7][Math.max(0, Math.min(5, rank))] || 0.15;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function deriveTimeRank(stats) {
  if (stats.maxLoopDepth >= 3) return 5;
  if (stats.maxLoopDepth === 2 || (stats.sorts && stats.maxSortLoopDepth > 0)) return 4;
  if (stats.sorts) return 3;
  if (stats.loops || stats.linearOps || stats.spreadCopies) return 2;
  return 0;
}

function timeLabelForRank(stats, rank) {
  if (stats.recursion) return "recursive local work — bound unknown";
  if (rank >= 5) return "O(n^3+) local — deeply nested iteration";
  if (rank === 4 && stats.sorts && stats.maxSortLoopDepth > 0) return "O(n^2 log n) local — sort inside iteration";
  if (rank === 4) return "O(n^2) local — nested iteration";
  if (rank === 3) return "O(n log n) local — sort";
  if (rank === 2 && stats.spreadCopies) return `O(n) local — ${plural(stats.spreadCopies, "shallow copy", "shallow copies")}`;
  if (rank === 2 && stats.loops) return `O(n) local — ${plural(stats.loops, "iteration", "iterations")}`;
  return rank === 2 ? "O(n) local — collection traversal" : "O(1) local";
}

function buildTimeSummary(stats) {
  const timeRank = stats.recursion ? Math.max(2, deriveTimeRank(stats)) : deriveTimeRank(stats);
  let timeLabel = timeLabelForRank(stats, timeRank);
  if (stats.asyncBoundaries || stats.externalCalls) timeLabel += " · I/O/callee-bound";
  else if (stats.callCount && !stats.recursion) timeLabel += " · callee-bound";
  if (stats.branches >= 8 && timeRank === 0) timeLabel += " · branch-heavy";
  return { timeRank, timeScore: timeScore(timeRank), timeLabel };
}

function buildMemorySummary(stats) {
  let memoryRank = 0;
  let memoryLabel = "O(1) auxiliary";
  const variableAllocation = stats.spreadCopies || stats.producerCalls;
  if (variableAllocation) {
    memoryRank = stats.maxVariableAllocationDepth >= 2 ? 4 : 2;
    memoryLabel = memoryRank >= 4 ? "O(n^2) — nested collection copies" : stats.spreadCopies
      ? `O(n) — ${plural(stats.spreadCopies, "shallow copy", "shallow copies")}`
      : "O(n) — produced collection";
  } else if (stats.recursion) {
    memoryRank = 1;
    memoryLabel = "O(depth) stack — recursive";
  } else if (stats.allocations) {
    memoryLabel = "O(1) auxiliary — fixed allocations";
  }
  return { memoryRank, memoryScore: memoryScore(memoryRank), memoryLabel };
}

export function buildLabels(stats) {
  return { ...buildTimeSummary(stats), ...buildMemorySummary(stats) };
}

export function buildEvidence(stats) {
  const out = [];
  if (stats.loops) out.push(plural(stats.loops, "iteration", "iterations"));
  if (stats.maxLoopDepth > 1) out.push(`loop depth ${stats.maxLoopDepth}`);
  if (stats.sorts) out.push(plural(stats.sorts, "sort", "sorts"));
  if (stats.spreadCopies) out.push(plural(stats.spreadCopies, "shallow copy", "shallow copies"));
  if (stats.allocationsInLoops) out.push(`${plural(stats.allocationsInLoops, "allocation", "allocations")} inside iteration`);
  if (stats.copiesInLoops) out.push(`${plural(stats.copiesInLoops, "copy", "copies")} inside iteration`);
  if (stats.linearOpsInLoops) out.push(`${plural(stats.linearOpsInLoops, "linear operation", "linear operations")} inside iteration`);
  if (stats.sortsInLoops) out.push(`${plural(stats.sortsInLoops, "sort", "sorts")} inside iteration`);
  if (stats.recursionInLoops) out.push(`${plural(stats.recursionInLoops, "recursive call", "recursive calls")} inside iteration`);
  if (stats.branches) out.push(plural(stats.branches, "branch point", "branch points"));
  if (stats.awaits) out.push(plural(stats.awaits, "await boundary", "await boundaries"));
  if (stats.callCount) out.push(plural(stats.callCount, "call", "calls"));
  if (stats.recursion) out.push("direct recursion");
  return out;
}
