import { makeFinding } from "./findings.js";

const TEST_PATH_RE = /(^|[/\\])(test|tests|__tests__|spec|e2e|__mocks__)([/\\]|$)|[._-](test|spec)\.[a-z0-9]+$|_test\.go$|(^|[/\\])test(?:_[^/\\]*)?\.py$/i;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentioned = (blob, name) => new RegExp(`(^|[^\\w@.-])${escRe(name)}($|[^\\w.-])`).test(blob);

// ---- Go: set math over ecosystem:"Go" externalImports vs go.mod requires ----
// goMod = parseGoMod() output. Only DIRECT requires can be "unused" (indirect ones belong to `go mod
// tidy`); replace targets and the own module never count. Missing = imported module with no require
// prefix — rare in Go (builds fail), so it usually flags vendored/replaced setups: keep it medium.
export function computeGoDepFindings({ externalImports = [], goMod = null, nonRuntimeRoots = [] } = {}) {
  const findings = [];
  if (!goMod || !goMod.module) return { findings, declared: new Set() };
  const requires = goMod.requires || [];
  const declared = new Set(requires.map((r) => r.path));
  const replaced = new Set((goMod.replaces || []).map((r) => r.from));
  const moduleOf = (spec) => { let best = ""; for (const p of declared) if ((spec === p || spec.startsWith(p + "/")) && p.length > best.length) best = p; return best; };

  const usedModules = new Set();
  const missing = new Map(); // pkg → { files:Set, lines:Map }
  const inNonRuntimeRoot = (file) => (nonRuntimeRoots || []).some((root) => {
    const f = String(file || "").replace(/\\/g, "/"), r = String(root || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    return !!r && (f === r || f.startsWith(`${r}/`));
  });
  for (const e of externalImports) {
    if (e.ecosystem !== "Go" || e.builtin || e.unresolved || !e.pkg) continue;
    const mod = moduleOf(e.spec || e.pkg) || (declared.has(e.pkg) ? e.pkg : "");
    if (mod) { usedModules.add(mod); continue; }
    let m = missing.get(e.pkg);
    if (!m) missing.set(e.pkg, (m = { files: new Set(), lines: new Map() }));
    m.files.add(e.file);
    if (!m.lines.has(e.file)) m.lines.set(e.file, e.line || 0);
  }

  for (const r of requires) {
    if (r.indirect || usedModules.has(r.path)) continue;
    findings.push(makeFinding({
      category: "unused",
      rule: "unused-dep",
      severity: "low",
      confidence: "medium",
      title: `Unused Go module: ${r.path}`,
      reason: "A direct go.mod requirement has no matching recorded Go import; build-tagged usage remains possible.",
      detail: `"${r.path}" is required (direct) in go.mod but no .go file imports it or any of its packages. Build-tag-guarded files can hide usage — confirm with \`go mod tidy\` before removing.`,
      package: r.path,
      version: r.version,
      source: "internal",
      fixHint: "go mod tidy (drops requires nothing imports)",
    }));
  }
  for (const [pkg, use] of missing) {
    if (replaced.has(pkg)) continue;
    const files = [...use.files];
    if (files.every(inNonRuntimeRoot)) continue;
    findings.push(makeFinding({
      category: "unused",
      rule: "missing-dep",
      severity: "medium",
      confidence: "medium",
      title: `Missing Go module: ${pkg}`,
      reason: "A recorded Go import has no matching direct go.mod requirement or replace entry.",
      detail: `"${pkg}" is imported by ${files.length} file(s) but go.mod has no matching require — a replace/workspace/vendor setup, or the module was never added.`,
      package: pkg,
      file: files[0],
      line: use.lines.get(files[0]) || 0,
      evidence: files.slice(0, 5).map((f) => ({ file: f, line: use.lines.get(f) || 0, snippet: "" })),
      source: "internal",
      fixHint: `go get ${pkg}`,
    }));
  }
  return { findings, declared };
}

// ---- Python: ecosystem:"PyPI" externalImports vs requirements/pyproject/Pipfile ----
// Import→dist naming is heuristic (yaml→PyYAML, python-X/X-python variants), so matching is GENEROUS for
// suppression and every unused finding stays low-confidence. CLI-only tools (pytest, black, gunicorn …)
// and stub/plugin conventions (types-*, *-stubs, pytest-*, flake8-*) are never flagged unused.
const PY_TOOL_DISTS = new Set(("pytest tox nox black ruff flake8 pylint mypy pyright isort bandit coverage pre-commit pip setuptools wheel build twine poetry poetry-core " +
  "pip-tools uv virtualenv pipenv gunicorn uwsgi supervisor ipython jupyter jupyterlab notebook ipykernel codecov autopep8 yapf commitizen detect-secrets safety pip-audit hatchling flit flit-core pdm").split(" "));
const pyNorm = (n) => String(n || "").toLowerCase().replace(/[-_.]+/g, "-");

function computePyDepFindingsFlat({
  externalImports = [], pyManifest = null, configTexts = new Map(),
  managedDependencies = [], ignoredDependencies = [], nonRuntimeRoots = [],
} = {}) {
  const findings = [];
  const deps = (pyManifest && pyManifest.deps) || [];
  const present = !!(pyManifest && pyManifest.present);
  const declared = new Set(deps.map((d) => pyNorm(d.name)));
  const managed = new Set((managedDependencies || []).map(pyNorm));
  const ignored = new Set((ignoredDependencies || []).map(pyNorm));
  const inNonRuntimeRoot = (file) => (nonRuntimeRoots || []).some((root) => {
    const f = String(file || "").replace(/\\/g, "/"), r = String(root || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    return !!r && (f === r || f.startsWith(`${r}/`));
  });
  for (const name of managed) declared.add(name);

  const used = new Map(); // top import → { dist, files:Set, lines:Map }
  for (const e of externalImports) {
    if (e.ecosystem !== "PyPI" || e.builtin || e.unresolved || !e.pkg) continue;
    const top = String(e.spec || e.pkg).split(".")[0];
    let u = used.get(top);
    if (!u) used.set(top, (u = { dist: e.pkg, files: new Set(), lines: new Map() }));
    u.files.add(e.file);
    if (!u.lines.has(e.file)) u.lines.set(e.file, e.line || 0);
  }
  // generous match: does declared dist D cover import top t (dist guess g)?
  const covers = (D, t, g) => {
    const d = pyNorm(D), nt = pyNorm(t), ng = pyNorm(g);
    return d === nt || d === ng || d === `python-${nt}` || d === `${nt}-python` || d === `${nt}-binary` || d.replace(/\d+$/, "") === nt.replace(/\d+$/, "");
  };

  const configBlob = [...configTexts.values()].join("\n");
  if (present) {
    for (const d of deps) {
      const n = pyNorm(d.name);
      if (managed.has(n) || ignored.has(n)) continue;
      if (d.buildSystem || PY_TOOL_DISTS.has(n) || /^types-|-stubs$|^pytest-|^flake8-|^sphinx/.test(n)) continue;
      let hit = false;
      for (const [top, u] of used) if (covers(d.name, top, u.dist)) { hit = true; break; }
      if (hit || mentioned(configBlob, d.name)) continue;
      findings.push(makeFinding({
        category: "unused",
        rule: "unused-dep",
        severity: d.dev ? "info" : "low",
        confidence: "low",
        title: `Unused Python dependency: ${d.name}`,
        reason: "No recorded Python import maps to this declared distribution; import-to-distribution mapping and plugin loading are heuristic.",
        detail: `"${d.name}" is declared but no .py file imports a module that maps to it. Import-name↔package-name mapping is heuristic and plugins/CLI tools load dynamically — review before removing.`,
        package: d.name,
        source: "internal",
        fixHint: `remove "${d.name}" from the manifest after confirming nothing imports or shells out to it`,
      }));
    }
  }
  for (const [top, u] of used) {
    if (ignored.has(pyNorm(top)) || ignored.has(pyNorm(u.dist)) || managed.has(pyNorm(top)) || managed.has(pyNorm(u.dist))) continue;
    let hit = false;
    for (const D of declared) if (covers(D, top, u.dist)) { hit = true; break; }
    if (hit) continue;
    const files = [...u.files];
    if (files.every(inNonRuntimeRoot)) continue;
    const testOnly = files.every((f) => TEST_PATH_RE.test(f));
    findings.push(makeFinding({
      category: "unused",
      rule: "missing-dep",
      severity: present ? (testOnly ? "low" : "medium") : "low",
      confidence: present ? "medium" : "low",
      title: `Missing Python dependency: ${u.dist}`,
      reason: present
        ? `A recorded Python import maps to "${u.dist}", but no declared distribution covers it.`
        : `A recorded Python import maps to "${u.dist}", but no Python dependency manifest is present; a managed runtime may provide it.`,
      detail: `"${top}" is imported by ${files.length} file(s) but ${present ? "no declared dependency provides it" : "the repo has no Python dependency manifest (requirements.txt / pyproject / Pipfile); a bundled or managed runtime may provide it"}${u.dist !== top ? ` (PyPI package is likely "${u.dist}")` : ""}.${present ? "" : " If this is intentional, declare it under python.managedDependencies in .weavatrix-deps.json."}`,
      package: u.dist,
      file: files[0],
      line: u.lines.get(files[0]) || 0,
      evidence: files.slice(0, 5).map((f) => ({ file: f, line: u.lines.get(f) || 0, snippet: "" })),
      source: "internal",
      fixHint: present ? `pip install ${u.dist}  (and add it to requirements.txt / pyproject)` : `add ${u.dist} to a Python manifest, or declare it as a managed runtime dependency`,
    }));
  }
  return { findings, declared, managed };
}

const normPyScope = (root) => String(root || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
const pyScopeOwns = (root, file) => !root || file === root || String(file || "").replace(/\\/g, "/").startsWith(`${root}/`);

export function computePyDepFindings(options = {}) {
  const scopes = Array.isArray(options.pyManifest?.scopes) ? options.pyManifest.scopes : [];
  if (!scopes.length) return computePyDepFindingsFlat(options);
  const normalized = scopes.map((scope) => ({ ...scope, root: normPyScope(scope.root) }))
    .sort((left, right) => right.root.length - left.root.length);
  if (!normalized.some((scope) => !scope.root)) normalized.push({ root: "", present: false, deps: [], manifests: [] });
  const importsByScope = new Map(normalized.map((scope) => [scope, []]));
  const configByScope = new Map(normalized.map((scope) => [scope, new Map()]));
  for (const entry of options.externalImports || []) {
    const owner = normalized.find((scope) => pyScopeOwns(scope.root, entry.file)) || normalized.at(-1);
    importsByScope.get(owner).push(entry);
  }
  for (const [file, text] of options.configTexts || new Map()) {
    const owner = normalized.find((scope) => pyScopeOwns(scope.root, file)) || normalized.at(-1);
    configByScope.get(owner).set(file, text);
  }
  const findings = [];
  const declared = new Set();
  const managed = new Set();
  for (const scope of normalized) {
    const result = computePyDepFindingsFlat({
      ...options,
      externalImports: importsByScope.get(scope),
      configTexts: configByScope.get(scope),
      pyManifest: {present: scope.present, deps: scope.deps || []},
    });
    findings.push(...result.findings.map((finding) => ({
      ...finding,
      ...(scope.manifests?.length ? {manifest: scope.manifests[0]} : {}),
      verification: finding.rule === "missing-dep"
        ? { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "ACTION_REQUIRED", manifestDeclaration: { status: scope.present ? "NOT_FOUND" : "NOT_PRESENT", files: scope.manifests || [] }, indexedSourceImports: { status: "FOUND", count: finding.evidence?.length || 1, files: (finding.evidence || []).map((item) => item.file) }, mapping: "PEP 503 plus bounded import-to-distribution aliases" }
        : { evidenceModel: "MANIFEST_PLUS_INDEXED_SOURCE", decision: "REVIEW_REQUIRED", manifestDeclaration: { status: "FOUND", files: scope.manifests || [] }, indexedSourceImports: { status: "ZERO_FOUND", completeness: "COMPLETE_FOR_GRAPH_SCOPE", count: 0, files: [] }, mapping: "PEP 503 plus bounded import-to-distribution aliases" },
    })));
    for (const name of result.declared) declared.add(`${scope.root || "."}:${name}`);
    for (const name of result.managed) managed.add(name);
  }
  return { findings, declared, managed };
}
