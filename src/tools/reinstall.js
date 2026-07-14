// "Reinstall dependencies" — re-materialize a repo's deps with the RIGHT package manager, detected from
// its lockfiles/manifests. JS: npm ci / yarn / pnpm / bun · Python: uv / poetry / pipenv / pip (venv
// only) · Go: go mod download. One explicit, user-triggered action that SHELLS OUT and MUTATES
// node_modules / the venv / the module cache — it is never part of a scan. See [[deps-security-engine]].
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../process.js";
import { commandAvailable, missingCommandMessage } from "./command-availability.js";
import { normalizeRepoRoot } from "./coverage.js";

const REINSTALL_TIMEOUT_MS = Number(process.env.WEAVATRIX_REINSTALL_TIMEOUT_MS || 900000); // 15 min

const has = (dir, f) => existsSync(join(dir, f));
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

// First existing pip requirements file (root pins first, then a requirements/ dir).
function firstRequirements(root) {
  let names = [];
  try { names = readdirSync(root).filter((n) => /^requirements[\w.-]*\.(txt|in)$/i.test(n)).sort(); } catch { /* unreadable */ }
  if (names.length) return names[0];
  try {
    const sub = readdirSync(join(root, "requirements")).filter((n) => /\.(txt|in)$/i.test(n)).sort();
    if (sub.length) return `requirements/${sub[0]}`;
  } catch { /* no requirements/ dir */ }
  return "";
}

// A venv's pip, if one exists (Windows Scripts\ vs posix bin/). Running bare `pip` would hit whatever
// interpreter is active — refuse that; poetry/pipenv/uv manage their own environments, pip does not.
function venvPip(root) {
  for (const v of ["venv", ".venv", "env"]) {
    for (const rel of [join(v, "Scripts", "pip.exe"), join(v, "bin", "pip")]) {
      if (has(root, rel)) return join(root, rel);
    }
  }
  return "";
}

// → [{ ecosystem, manager, cmd, args, why, run }] — the reinstall plan for everything this repo declares.
// run:false plans are surfaced but NOT executed (e.g. pip with no virtualenv) so we never install into
// a global interpreter behind the user's back.
export function detectReinstallPlans(repoPath) {
  const root = normalizeRepoRoot(repoPath);
  const plans = [];

  // ---- JavaScript / Node (lockfile picks the manager; clean/frozen install when a lock is present) ----
  if (has(root, "package.json")) {
    if (has(root, "bun.lockb") || has(root, "bun.lock")) plans.push({ ecosystem: "JavaScript", manager: "bun", cmd: "bun", args: ["install", "--frozen-lockfile"], why: "bun lockfile", run: true });
    else if (has(root, "pnpm-lock.yaml")) plans.push({ ecosystem: "JavaScript", manager: "pnpm", cmd: "pnpm", args: ["install", "--frozen-lockfile"], why: "pnpm-lock.yaml", run: true });
    else if (has(root, "yarn.lock")) plans.push({ ecosystem: "JavaScript", manager: "yarn", cmd: "yarn", args: ["install", "--frozen-lockfile"], why: "yarn.lock", run: true });
    else if (has(root, "package-lock.json")) plans.push({ ecosystem: "JavaScript", manager: "npm", cmd: "npm", args: ["ci"], why: "package-lock.json → npm ci (clean install)", run: true });
    else plans.push({ ecosystem: "JavaScript", manager: "npm", cmd: "npm", args: ["install"], why: "package.json (no lockfile)", run: true });
  }

  // ---- Python (self-managed venvs first; bare pip only against an existing venv) ----
  const pyproject = readText(join(root, "pyproject.toml"));
  if (has(root, "uv.lock")) plans.push({ ecosystem: "PyPI", manager: "uv", cmd: "uv", args: ["sync", "--frozen"], why: "uv.lock", run: true });
  else if (has(root, "poetry.lock") || /^\s*\[tool\.poetry\]/m.test(pyproject)) plans.push({ ecosystem: "PyPI", manager: "poetry", cmd: "poetry", args: ["install"], why: has(root, "poetry.lock") ? "poetry.lock" : "pyproject [tool.poetry]", run: true });
  else if (has(root, "Pipfile.lock") || has(root, "Pipfile")) plans.push({ ecosystem: "PyPI", manager: "pipenv", cmd: "pipenv", args: ["sync"], why: has(root, "Pipfile.lock") ? "Pipfile.lock" : "Pipfile", run: true });
  else {
    const req = firstRequirements(root);
    if (req) {
      const pip = venvPip(root);
      if (pip) plans.push({ ecosystem: "PyPI", manager: "pip", cmd: pip, args: ["install", "-r", req], why: `${req} → venv pip`, run: true });
      else plans.push({
        ecosystem: "PyPI",
        manager: "pip",
        cmd: "pip",
        args: ["install", "-r", req],
        why: req,
        run: false,
        skipCode: "python-no-venv",
        skip: "No repo virtualenv found (.venv/venv/env). Skipped bare pip so weavatrix does not modify global Python. Create a venv or use uv/poetry/pipenv, then run Reinstall deps again.",
      });
    }
  }

  // ---- Go ----
  if (has(root, "go.mod")) plans.push({ ecosystem: "Go", manager: "go", cmd: "go", args: ["mod", "download"], why: "go.mod", run: true });

  return plans;
}

const tail = (s, n = 2000) => { const t = String(s || "").trim(); return t.length > n ? "…" + t.slice(-n) : t; };

// Run the detected reinstall plans. Each plan runs in the repo root; per-plan failures don't abort the
// rest (a repo can be JS + Go). `clean` wipes node_modules first (a "clean reinstall" for a corrupt /
// stale tree). Returns { ok, repo, cleaned, plans:[{manager, command, ecosystem, ran, ok, exitCode,
// output, error, skip}] }.
export async function reinstallDeps(repoPath, { timeoutMs = REINSTALL_TIMEOUT_MS, clean = false } = {}) {
  const root = normalizeRepoRoot(repoPath);
  if (!existsSync(root)) return { ok: false, error: "Repo path not found" };
  const plans = detectReinstallPlans(root);
  if (!plans.length) return { ok: false, error: "Nothing to reinstall — no package.json, requirements/pyproject/Pipfile, or go.mod found" };

  // Clean reinstall: delete node_modules so the manager rebuilds the tree from scratch (fixes a
  // corrupt/partial install). Scoped to node_modules — we never wipe a venv or the Go module cache.
  let cleaned = false;
  if (clean && plans.some((p) => p.ecosystem === "JavaScript") && existsSync(join(root, "node_modules"))) {
    try { rmSync(join(root, "node_modules"), { recursive: true, force: true }); cleaned = true; } catch { /* locked/partial — the install still runs */ }
  }

  const results = [];
  for (const p of plans) {
    const command = `${p.manager === "pip" && p.cmd !== "pip" ? "pip" : p.cmd} ${p.args.join(" ")}`;
    if (!p.run) { results.push({ ecosystem: p.ecosystem, manager: p.manager, command, why: p.why, ran: false, ok: false, skip: p.skip, skipCode: p.skipCode || "" }); continue; }
    if (!(await commandAvailable(p.cmd))) {
      results.push({ ecosystem: p.ecosystem, manager: p.manager, command, why: p.why, ran: false, ok: false, skip: missingCommandMessage(p.manager) });
      continue;
    }
    try {
      const r = await runCommand(p.cmd, p.args, { cwd: root, timeoutMs });
      results.push({ ecosystem: p.ecosystem, manager: p.manager, command, why: p.why, ran: true, ok: r.exitCode === 0, exitCode: r.exitCode, output: tail(`${r.stdout || ""}\n${r.stderr || ""}`) });
    } catch (error) {
      // ENOENT = manager not installed / not on PATH; timeout surfaces here too
      results.push({ ecosystem: p.ecosystem, manager: p.manager, command, why: p.why, ran: true, ok: false, error: /ENOENT/.test(error.message) ? `${p.manager} not found on PATH` : error.message });
    }
  }
  return { ok: results.some((r) => r.ok), repo: root, cleaned, plans: results };
}
