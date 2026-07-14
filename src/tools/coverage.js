// "Measure coverage" — run a repo's own test suite with coverage instrumentation, producing a report
// that graph-builder-analysis.js already reads (coverage/lcov.info, lcov.info, coverage.out, …). This is what
// makes the graph actually reflect test coverage without the user hand-generating a report.
// Best-effort + stack-detected; EXECUTES the repo's tests (needs its deps installed). See [[graph-builder-internalization]].
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../process.js";
import { commandAvailable, missingCommandMessage, resolveExePath } from "./command-availability.js";

const COVERAGE_TIMEOUT_MS = Number(process.env.WEAVATRIX_COVERAGE_TIMEOUT_MS || 600000);

// Normalize whatever the caller hands us into a usable repo root. Persisted settings / IPC payloads
// have surfaced paths with stray whitespace, wrapping quotes, file:// prefixes or trailing separators —
// existsSync(repoPath) can still pass for some of those while EVERY marker probe (join(root, "go.mod"),
// …) misses, which made detection fail with "No supported test stack" on repos that clearly have one.
export function normalizeRepoRoot(repoPath) {
  let p = String(repoPath || "").trim().replace(/^"+|"+$/g, "").replace(/^file:\/\//i, "");
  // strip trailing separators, but never turn a drive root ("C:\") into a drive-relative "C:"
  if (!/^[A-Za-z]:[\\/]$/.test(p)) p = p.replace(/[\\/]+$/, "");
  return p;
}

// pytest projects often carry NO root manifest at all — just tests/test_*.py (or conftest.py in tests/).
function hasPytestFiles(root) {
  for (const dir of ["", "tests", "test"]) {
    let entries;
    try { entries = readdirSync(dir ? join(root, dir) : root, { withFileTypes: true }); } catch { continue; }
    if (entries.some((e) => e.isFile() && (/^test_.*\.py$/.test(e.name) || /_test\.py$/.test(e.name) || e.name === "conftest.py"))) return true;
  }
  return false;
}

// "node --test …" scripts may pin the test roots ("node --test test/ tests/"); keep those positional
// args so our coverage run exercises the same files. Loader flags (--import tsx, -r ts-node/register)
// are kept WITH their values — without them TS suites can't load; every other flag (and its value)
// is dropped and replaced by our coverage flags.
const NODE_KEEP_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C"]);
const NODE_VALUE_FLAGS = new Set([...NODE_KEEP_FLAGS, "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-shard", "--test-concurrency"]);
export function nodeTestExtraArgs(testScript) {
  const m = /\bnode(?:\.exe)?\b([^&|;]*)/.exec(testScript);
  if (!m) return [];
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-")) { out.push(t); continue; } // positional test path
    const eq = t.indexOf("=");
    const name = eq > 0 ? t.slice(0, eq) : t;
    const next = tokens[i + 1];
    if (NODE_KEEP_FLAGS.has(name)) {
      if (eq > 0) out.push(t);
      else if (next && !next.startsWith("-")) { out.push(t, next); i++; }
      continue;
    }
    if (NODE_VALUE_FLAGS.has(name) && eq < 0 && next && !next.startsWith("-")) i++; // skip the flag's value too
  }
  return out;
}

function readPackage(root) {
  // Windows-authored package.json files can carry a UTF-8 BOM — JSON.parse rejects it, which would
  // silently disable jest/vitest/node --test detection for that repo. Strip it.
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return {}; }
}

// Bun's zero-arg discovery only runs *.test.* / *_test.* / *.spec.* / *_spec.* files, skipping
// node_modules and dot-dirs (verified against bun 1.3 \u2014 it DOES descend into dist/, build/, \u2026).
// Repos like edge-analytics keep the bulk of their suite as *.itest.js, run through scripts with
// explicit file lists ("test:service": "bun test ./src/\u2026itest.js \u2026") \u2014 a plain `bun test --coverage`
// silently skips all of them and reports a misleadingly tiny coverage number. Harvest those explicit
// paths from test-ish scripts. Script NAMES and file PATHS flavoured e2e/integration are excluded
// (they need live infra) \u2014 matched as whole [:._-]/path segments so "test:upload" (contains "load")
// and "loader.itest.js" stay eligible.
const BUN_SKIP_SCRIPT_NAME = /(^|[:._-])(e2e|integration|smoke|acceptance|bench|load|perf)(?=[:._-]|$)/i;
const BUN_SKIP_PATH = /\.(e2e|integration)\.|(^|\/)(e2e|integration)\//i;
// Preload/env flags are KEPT (canonicalized to --flag=value) \u2014 harvested suites can rely on them
// (happy-dom registrators, env mocks). Other value-taking flags get their SEPARATE value skipped so
// "--preload ./setup.ts" never turns a setup module into a test file (same idea as NODE_VALUE_FLAGS).
const BUN_KEEP_FLAGS = new Set(["--preload", "-r", "--env-file"]);
const BUN_VALUE_FLAGS = new Set([...BUN_KEEP_FLAGS, "--require", "--timeout", "-t", "--test-name-pattern", "--rerun-each", "--reporter", "--reporter-outfile", "--coverage-reporter", "--coverage-dir"]);

// npm scripts quote paths containing spaces \u2014 a plain \s+ split would shred them into garbage tokens.
function shellTokens(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// \u2192 { files: ["src/a.itest.js", \u2026] (normalized, no "./"), keepFlags: ["--preload=./setup.ts", \u2026] }
export function bunScriptTestFiles(pkg) {
  const files = [];
  const keepFlags = new Set();
  for (const [name, script] of Object.entries((pkg && pkg.scripts) || {})) {
    if (typeof script !== "string") continue;
    if (!/^test([:._-]|$)/i.test(name) || BUN_SKIP_SCRIPT_NAME.test(name)) continue;
    // one script can chain several runs ("bun test ./a && bun test ./b") \u2014 harvest every segment;
    // `test` must be bun's SUBCOMMAND ("bun build ./src/test.ts" must not match)
    for (const seg of script.split(/&&|\|\||[;|]/)) {
      const m = /(?:^|\s)bun(?:\.exe)?\s+test(?=\s|$)/i.exec(seg);
      if (!m) continue;
      const tokens = shellTokens(seg.slice(m.index + m[0].length));
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.startsWith("-")) {
          const eq = tok.indexOf("=");
          const flag = eq > 0 ? tok.slice(0, eq) : tok;
          const canon = flag === "-r" ? "--preload" : flag;
          const next = tokens[i + 1];
          if (BUN_KEEP_FLAGS.has(flag)) {
            if (eq > 0) keepFlags.add(`${canon}=${tok.slice(eq + 1)}`);
            else if (next && !next.startsWith("-")) { keepFlags.add(`${canon}=${next}`); i++; }
          } else if (BUN_VALUE_FLAGS.has(flag) && eq < 0 && next && !next.startsWith("-")) {
            i++; // skip the flag's value \u2014 it must not be mistaken for a test file
          }
          continue;
        }
        const p = tok.replace(/\\/g, "/").replace(/^\.\//, "");
        if (!/\.[cm]?[jt]sx?$/i.test(p)) continue; // explicit files only \u2014 dirs/name filters are ambiguous
        if (BUN_SKIP_PATH.test(p)) continue;
        files.push(p);
      }
    }
  }
  return { files, keepFlags: [...keepFlags] };
}

const BUN_DEFAULT_TEST_RE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$/i;

// Files bun's zero-arg discovery would run (parity walk: skip only node_modules + dot-dirs, like bun).
// Needed because passing ANY positional path to `bun test` turns discovery OFF \u2014 without this the
// harvested itest files would REPLACE the *.test.* ones. Returns null when a cap is hit: an
// incomplete walk must NOT masquerade as bun's discovery.
function bunDefaultTestFiles(root, capFiles = 400, capDirs = 4000) {
  const found = [];
  const stack = [""];
  let dirsVisited = 0;
  while (stack.length) {
    if (++dirsVisited > capDirs) return null;
    const rel = stack.pop();
    let entries;
    try { entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) stack.push(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile() && BUN_DEFAULT_TEST_RE.test(e.name)) {
        found.push(rel ? `${rel}/${e.name}` : e.name);
        if (found.length > capFiles) return null;
      }
    }
  }
  return found;
}

// Union of harvested script files + bun's default-discovered files: "./"-prefixed, existing, deduped.
// NEVER-WORSE-THAN-PLAIN guarantee: explicit mode only activates when (a) at least one harvested file
// really exists (a glob token or stale path must not switch modes), (b) the parity walk saw the whole
// repo, and (c) the arg list stays comfortably inside cmd.exe's ~8k limit (winQuote can grow args).
// Otherwise fall back to plain `bun test` and say so via warn (runCoverage puts it in the log).
function bunCoverageArgs(root, pkg) {
  const { files, keepFlags } = bunScriptTestFiles(pkg);
  const seen = new Set();
  const harvested = [];
  for (const p of files) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(join(root, p))) harvested.push(`./${p}`);
  }
  if (!harvested.length) return { args: [], warn: "" };
  const defaults = bunDefaultTestFiles(root);
  if (defaults === null) {
    return { args: [], warn: `repo too large to enumerate test files \u2014 ran bun's default discovery only (${harvested.length} script-listed test files not included in coverage)` };
  }
  const out = [...harvested];
  for (const raw of defaults) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(`./${raw}`);
  }
  let chars = keepFlags.reduce((n, f) => n + f.length + 1, 0);
  for (const a of out) chars += a.length + 1;
  if (chars > 6000) {
    return { args: [], warn: `explicit test list too long for one command line \u2014 ran bun's default discovery only (${harvested.length} script-listed test files not included in coverage)` };
  }
  return { args: [...keepFlags, ...out], warn: "" };
}

// Decide HOW to measure coverage for this repo. Returns { stack, steps:[[cmd,args]], report, note } or null.
export function detectCoverage(repoPath) {
  const root = normalizeRepoRoot(repoPath);
  if (!root) return null;
  const has = (f) => existsSync(join(root, f));
  if (has("package.json")) {
    const pkg = readPackage(root);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const testScript = (pkg.scripts && typeof pkg.scripts.test === "string" && pkg.scripts.test) || "";
    if (deps.vitest || /\bvitest\b/.test(testScript)) {
      return { stack: "vitest", steps: [["npx", ["--no-install", "vitest", "run", "--coverage", "--coverage.reporter=lcov", "--coverage.reporter=json-summary"]]], report: "coverage/lcov.info", note: "needs @vitest/coverage-v8 installed" };
    }
    if (deps.jest || /\bjest\b/.test(testScript)) {
      return { stack: "jest", steps: [["npx", ["--no-install", "jest", "--coverage", "--coverageReporters=lcov", "--coverageReporters=json-summary"]]], report: "coverage/lcov.info", note: "needs jest installed" };
    }
    if (/\bbun(?:\.exe)?\b[^&|;]*\stest\b/.test(testScript)) {
      const { args, warn } = bunCoverageArgs(root, pkg);
      return { stack: "bun", steps: [["bun", ["test", "--coverage", "--coverage-reporter=lcov", ...args]]], report: "coverage/lcov.info", note: "needs Bun installed", warn };
    }
    if (/\bnode(?:\.exe)?\b[^&|;]*\s--test\b/.test(testScript)) {
      // node's built-in runner (this repo's own stack): the lcov reporter + --experimental-test-coverage
      // write an lcov.info the graph analysis already knows how to read (coverage-reports.js parseLcov).
      const args = [
        "--test", "--experimental-test-coverage",
        "--test-reporter=spec", "--test-reporter-destination=stdout",
        "--test-reporter=lcov", "--test-reporter-destination=lcov.info",
        ...nodeTestExtraArgs(testScript)
      ];
      return { stack: "node-test", steps: [["node", args]], report: "lcov.info", note: "needs Node 20.11+ (built-in lcov coverage reporter)" };
    }
  }
  if (has("go.mod")) {
    return { stack: "go", steps: [["go", ["test", "./...", "-coverprofile=coverage.out"]]], report: "coverage.out", note: "" };
  }
  if (has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("requirements.txt") || has("conftest.py") || has("pytest.ini") || has("tox.ini") || hasPytestFiles(root)) {
    // `coverage` drives pytest, then exports lcov (coverage>=6.3). Needs `coverage` + pytest installed.
    return { stack: "python", steps: [["python", ["-m", "coverage", "run", "-m", "pytest", "-q"]], ["python", ["-m", "coverage", "lcov", "-o", "lcov.info"]]], report: "lcov.info", note: "needs pytest + coverage installed" };
  }
  return null;
}

// When nothing is detected, say WHY — "No supported test stack" on a repo with an obvious test script
// (bun test, mocha, …) is otherwise indistinguishable from a plumbing bug.
function detectFailureHint(root) {
  if (!existsSync(join(root, "package.json"))) return "";
  const pkg = readPackage(root);
  const testScript = (pkg.scripts && typeof pkg.scripts.test === "string" && pkg.scripts.test) || "";
  return testScript ? ` package.json test script is "${testScript}" — only jest, vitest, bun test and node --test are runnable here.` : "";
}

const REPORTS = ["coverage/lcov.info", "lcov.info", "coverage/coverage-summary.json", "coverage/coverage-final.json", "coverage.out", "cover.out", "coverage/coverage.json", "coverage.json"];
function freshReport(repoPath, since) {
  for (const r of REPORTS) {
    const p = join(repoPath, r);
    try { if (existsSync(p) && statSync(p).mtimeMs >= since - 1000) return r; } catch { /* skip */ }
  }
  return "";
}

export async function runCoverage(repoPath) {
  const root = normalizeRepoRoot(repoPath);
  if (!root || !existsSync(root)) return { ok: false, error: "Repo path not found" };
  const plan = detectCoverage(root);
  if (!plan) return { ok: false, error: `No supported test stack detected (jest/vitest/bun test, node --test, pytest, or go).${detectFailureHint(root)}` };
  const started = Date.now();
  // warn (e.g. "explicit test list too long — defaults only") goes AFTER the tail-slice so verbose
  // test output can never push it out of the panel.
  const warnPrefix = plan.warn ? `⚠ ${plan.warn}\n\n` : "";
  let log = "";
  for (const [cmd, args] of plan.steps) {
    if (!(await commandAvailable(cmd))) {
      return { ok: false, stack: plan.stack, error: `${missingCommandMessage(cmd)}${plan.note ? ` (${plan.note})` : ""}`, log };
    }
    // Spawn the real .exe directly when there is one: EDR/AV heuristics have blocked our cmd.exe
    // shell line (bun + 30 test paths → spawn EPERM) even though the direct spawn runs fine.
    const exe = await resolveExePath(cmd);
    let res;
    try { res = await runCommand(exe || cmd, args, { cwd: root, timeoutMs: COVERAGE_TIMEOUT_MS }); }
    catch (e) { return { ok: false, stack: plan.stack, error: `${cmd} failed to start: ${e.message}${plan.note ? ` (${plan.note})` : ""}`, log }; }
    log += `$ ${cmd} ${args.join(" ")}\n${(res.stdout || "").slice(-1500)}${res.stderr ? `\n${res.stderr.slice(-1500)}` : ""}\n`;
    // tests may exit non-zero (a failing test) yet still emit coverage — so we check the report, not exitCode.
  }
  // pytest step 2 (coverage lcov) only makes sense if step 1 ran; report freshness is the real success signal.
  const report = freshReport(root, started);
  if (!report) {
    return { ok: false, stack: plan.stack, error: `Ran the ${plan.stack} suite but no coverage report appeared${plan.note ? ` — ${plan.note}` : ""}. See log.`, log: warnPrefix + log.slice(-4000) };
  }
  return { ok: true, stack: plan.stack, report, log: warnPrefix + log.slice(-2000) };
}
