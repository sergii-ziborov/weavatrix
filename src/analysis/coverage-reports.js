// graph-builder-coverage.js — coverage-report readers for the graph analysis. Parses Istanbul (summary/final),
// lcov, Python coverage.json, and Go coverage.out into per-file line-hit maps, resolving report paths onto the
// graph's known files. Split out of graph-builder-analysis.js (pure except for reading the repo's coverage files).
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRepoBoundary } from "../repo-path.js";
import { readTarpaulinCoverage } from "./coverage-reports-tarpaulin.js";

export function normRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function dirOfRepoPath(value) {
  const p = normRepoPath(value);
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

export function normalizeRepoParts(value) {
  const out = [];
  for (const part of normRepoPath(value).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function pct01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

export function pctFromCounts(covered, total) {
  const c = Number(covered);
  const t = Number(total);
  if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.min(1, c / t));
}

function resolveCoverageFile(rawPath, knownFiles, repoRoot) {
  const known = (knownFiles || []).map(normalizeRepoParts).filter(Boolean);
  const knownSet = new Set(known);
  const candidates = [];
  const add = (value) => {
    const p = normalizeRepoParts(value);
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  const raw = String(rawPath || "").replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  const normalizedRaw = normRepoPath(raw);
  add(normalizedRaw);
  add(normalizedRaw.replace(/^\.\//, ""));
  if (repoRoot) {
    try {
      const rel = normRepoPath(relative(repoRoot, raw));
      if (rel && !rel.startsWith("..")) add(rel);
    } catch {
      /* best effort */
    }
    const rootPrefix = `${normRepoPath(resolve(repoRoot)).toLowerCase()}/`;
    const lowerRaw = normalizedRaw.toLowerCase();
    if (lowerRaw.startsWith(rootPrefix)) add(normalizedRaw.slice(rootPrefix.length));
  }
  for (const candidate of candidates) if (knownSet.has(candidate)) return candidate;
  const lower = normalizedRaw.toLowerCase();
  const suffixHit = known
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((file) => lower.endsWith(`/${file.toLowerCase()}`) || lower === file.toLowerCase());
  return suffixHit || candidates[0] || "";
}

function mergeCoverageEntry(map, rawPath, entry, knownFiles, repoRoot) {
  const file = resolveCoverageFile(rawPath, knownFiles, repoRoot);
  if (!file) return;
  const current = map.get(file) || {};
  map.set(file, {
    pct: entry.pct != null ? entry.pct : current.pct ?? null,
    total: entry.total != null ? entry.total : current.total ?? null,
    covered: entry.covered != null ? entry.covered : current.covered ?? null,
    lines: entry.lines || current.lines || null,
    source: current.source && entry.source ? `${current.source}, ${entry.source}` : entry.source || current.source || ""
  });
}

function addLineHit(lines, line, hit) {
  const value = Number(line);
  if (!Number.isFinite(value) || value <= 0) return;
  const n = Math.round(value);
  if (n < 1) return;
  const current = lines.get(n);
  lines.set(n, Math.max(Number(current) || 0, Number(hit) || 0));
}

function parseIstanbulSummary(map, filePath, knownFiles, repoRoot) {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  for (const [raw, value] of Object.entries(json || {})) {
    if (raw === "total" || !value || typeof value !== "object") continue;
    const lines = value.lines || value.statements || {};
    mergeCoverageEntry(map, raw, {
      pct: pct01(lines.pct),
      total: Number.isFinite(Number(lines.total)) ? Number(lines.total) : null,
      covered: Number.isFinite(Number(lines.covered)) ? Number(lines.covered) : null,
      source: "coverage-summary.json"
    }, knownFiles, repoRoot);
  }
}

function parseIstanbulFinal(map, filePath, knownFiles, repoRoot) {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  for (const [raw, record] of Object.entries(json || {})) {
    if (!record || typeof record !== "object") continue;
    const statementMap = record.statementMap || {};
    const hits = record.s || {};
    const lines = new Map();
    for (const [id, loc] of Object.entries(statementMap)) {
      const hit = Number(hits[id]) || 0;
      const start = Math.max(1, Math.round(Number(loc?.start?.line) || 0));
      const end = Math.max(start, Math.round(Number(loc?.end?.line) || start));
      for (let line = start; line <= end; line++) addLineHit(lines, line, hit);
    }
    const total = lines.size;
    const covered = [...lines.values()].filter((hit) => Number(hit) > 0).length;
    mergeCoverageEntry(map, record.path || raw, {
      pct: pctFromCounts(covered, total),
      total,
      covered,
      lines,
      source: "coverage-final.json"
    }, knownFiles, repoRoot);
  }
}

function parseLcov(map, filePath, knownFiles, repoRoot) {
  const flush = (record) => {
    if (!record || !record.file) return;
    const total = record.total ?? record.lines.size;
    const covered = record.covered ?? [...record.lines.values()].filter((hit) => Number(hit) > 0).length;
    mergeCoverageEntry(map, record.file, {
      pct: pctFromCounts(covered, total),
      total,
      covered,
      lines: record.lines,
      source: "lcov.info"
    }, knownFiles, repoRoot);
  };
  let current = null;
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      flush(current);
      current = { file: line.slice(3), lines: new Map(), total: null, covered: null };
    } else if (current && line.startsWith("DA:")) {
      const [lineNo, count] = line.slice(3).split(",");
      addLineHit(current.lines, lineNo, count);
    } else if (current && line.startsWith("LF:")) {
      current.total = Number(line.slice(3)) || current.total;
    } else if (current && line.startsWith("LH:")) {
      current.covered = Number(line.slice(3)) || current.covered;
    } else if (line === "end_of_record") {
      flush(current);
      current = null;
    }
  }
  flush(current);
}

function parseCoveragePyJson(map, filePath, knownFiles, repoRoot) {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  for (const [raw, file] of Object.entries(json?.files || {})) {
    const lines = new Map();
    for (const line of file.executed_lines || []) addLineHit(lines, line, 1);
    for (const line of file.missing_lines || []) if (!lines.has(Number(line))) addLineHit(lines, line, 0);
    const summary = file.summary || {};
    const total = Number(summary.num_statements) || lines.size;
    const covered = Number(summary.covered_lines) || [...lines.values()].filter((hit) => Number(hit) > 0).length;
    mergeCoverageEntry(map, raw, {
      pct: pct01(summary.percent_covered ?? summary.percent_covered_display) ?? pctFromCounts(covered, total),
      total,
      covered,
      lines,
      source: "coverage.json"
    }, knownFiles, repoRoot);
  }
}

function parseGoCoverage(map, filePath, knownFiles, repoRoot) {
  const byFile = new Map();
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("mode:")) continue;
    const m = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/);
    if (!m) continue;
    const record = byFile.get(m[1]) || { lines: new Map() };
    const start = Math.max(1, Number(m[2]) || 1);
    const end = Math.max(start, Number(m[3]) || start);
    for (let n = start; n <= end; n++) addLineHit(record.lines, n, Number(m[4]) || 0);
    byFile.set(m[1], record);
  }
  for (const [raw, record] of byFile) {
    const total = record.lines.size;
    const covered = [...record.lines.values()].filter((hit) => Number(hit) > 0).length;
    mergeCoverageEntry(map, raw, {
      pct: pctFromCounts(covered, total),
      total,
      covered,
      lines: record.lines,
      source: "coverage.out"
    }, knownFiles, repoRoot);
  }
}

function parseTarpaulinJson(map, filePath, knownFiles, repoRoot) {
  for (const record of readTarpaulinCoverage(filePath)) {
    mergeCoverageEntry(map, record.path, record.entry, knownFiles, repoRoot);
  }
}

export function readCoverageForRepo(repoRoot, knownFiles) {
  const out = new Map();
  if (!repoRoot) return out;
  const boundary = createRepoBoundary(repoRoot);
  const candidates = [
    ["coverage/coverage-summary.json", parseIstanbulSummary],
    ["coverage/coverage-final.json", parseIstanbulFinal],
    ["coverage/lcov.info", parseLcov],
    ["lcov.info", parseLcov],
    ["coverage/coverage.json", parseCoveragePyJson],
    ["coverage.json", parseCoveragePyJson],
    ["tarpaulin-report.json", parseTarpaulinJson],
    ["coverage/tarpaulin-report.json", parseTarpaulinJson],
    ["coverage.out", parseGoCoverage],
    ["cover.out", parseGoCoverage]
  ];
  for (const [candidate, parser] of candidates) {
    const resolved = boundary.resolve(candidate);
    if (!resolved.ok || !existsSync(resolved.path)) continue;
    try {
      parser(out, resolved.path, knownFiles, repoRoot);
    } catch {
      /* malformed/foreign coverage report: ignore */
    }
  }
  return out;
}
