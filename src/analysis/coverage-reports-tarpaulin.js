import { readFileSync } from "node:fs";

function pct01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function pctFromCounts(covered, total) {
  const c = Number(covered);
  const t = Number(total);
  if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.min(1, c / t));
}

function addLineHit(lines, line, hit) {
  const value = Number(line);
  if (!Number.isFinite(value) || value <= 0) return;
  const n = Math.round(value);
  if (n < 1) return;
  const current = lines.get(n);
  lines.set(n, Math.max(Number(current) || 0, Number(hit) || 0));
}

function numericLineList(value) {
  const input = Array.isArray(value) ? value : [];
  return input
    .map((line) => Number(line))
    .filter((line) => Number.isFinite(line) && line > 0)
    .map((line) => Math.round(line));
}

function legacyLineGroups(record) {
  if (!record || typeof record !== "object") return { covered: [], uncovered: [] };
  const lines = record.lines && typeof record.lines === "object" ? record.lines : {};
  return {
    covered: [
      ...numericLineList(record.covered),
      ...numericLineList(record.covered_lines),
      ...numericLineList(record.coveredLines),
      ...numericLineList(lines.covered),
      ...numericLineList(lines.covered_lines),
    ],
    uncovered: [
      ...numericLineList(record.uncovered),
      ...numericLineList(record.uncovered_lines),
      ...numericLineList(record.uncoveredLines),
      ...numericLineList(record.missing),
      ...numericLineList(record.missing_lines),
      ...numericLineList(lines.uncovered),
      ...numericLineList(lines.uncovered_lines),
      ...numericLineList(lines.missing),
    ],
  };
}

function recordPath(record) {
  const raw = record?.path || record?.file || record?.filename || record?.name;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).join("/");
  return raw;
}

function reportEntries(json) {
  const files = json?.files || json?.coverage || json;
  if (Array.isArray(files)) {
    return files.map((record) => [recordPath(record), record]).filter(([raw]) => raw);
  }
  if (files && typeof files === "object") return Object.entries(files);
  return [];
}

function coveragePct(record, covered, total) {
  const summary = record?.summary && typeof record.summary === "object" ? record.summary : {};
  return pct01(
    record?.coverage
    ?? record?.coverage_percentage
    ?? record?.line_coverage
    ?? summary.coverage
    ?? summary.coverage_percentage
    ?? summary.percent
  )
    ?? pctFromCounts(record?.covered, record?.coverable)
    ?? pctFromCounts(covered, total);
}

export function readTarpaulinCoverage(filePath) {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  return reportEntries(json).map(([path, record]) => {
    const lines = new Map();
    for (const trace of Array.isArray(record?.traces) ? record.traces : []) {
      if (!trace?.stats || typeof trace.stats !== "object" || !("Line" in trace.stats)) continue;
      addLineHit(lines, trace.line, trace.stats.Line);
    }
    const legacy = legacyLineGroups(record);
    for (const line of legacy.uncovered) addLineHit(lines, line, 0);
    for (const line of legacy.covered) addLineHit(lines, line, 1);
    const measuredTotal = lines.size;
    const measuredCovered = [...lines.values()].filter((hit) => Number(hit) > 0).length;
    const reportedTotal = Number(record?.coverable);
    const reportedCovered = Number(record?.covered);
    return {
      path,
      entry: {
        pct: coveragePct(record, measuredCovered, measuredTotal),
        total: Number.isFinite(reportedTotal) ? reportedTotal : measuredTotal,
        covered: Number.isFinite(reportedCovered) ? reportedCovered : measuredCovered,
        lines,
        source: "tarpaulin-report.json",
      },
    };
  });
}
