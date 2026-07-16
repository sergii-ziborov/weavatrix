// Pure dependency checker (replaces depcheck + knip's dependency output) — set math over the graph's
// externalImports vs package.json. NO filesystem here: the fs wrapper is internal-audit.js, so this is
// fully unit-testable (same pattern as dead-check.js computeDead). See DEPS_SECURITY_PLAN.md (P1).
//
// Philosophy: bias to FALSE-NEGATIVES. A dep we can't prove unused stays unflagged (or drops to low
// confidence) — knip's ~100 framework plugins know config conventions we don't, so we compensate with
// script/config-text mention scanning + a config-ecosystem prefix rule, and we NEVER say "safe to
// auto-remove", only "review".
import { makeFinding } from "./findings.js";

// Packages referenced by config CONVENTION, not imports (eslint extends "airbnb" → eslint-config-airbnb).
// Flagged only at low confidence when nothing mentions them anywhere.
const CONFIG_ECOSYSTEM_RE =
  /^(eslint-(config|plugin)-|@typescript-eslint\/|@eslint\/|prettier-plugin-|postcss-|autoprefixer$|tailwindcss$|babel-(plugin|preset)-|@babel\/(plugin|preset)-|stylelint-|@commitlint\/|commitlint-|remark-|rehype-|@semantic-release\/|karma-|grunt-|gulp-)/;

// CLI name → package name, for script commands whose binary doesn't equal the package
// (`tsc` comes from typescript, `depcruise` from dependency-cruiser, …).
const BIN_PKG = {
  tsc: "typescript",
  depcruise: "dependency-cruiser",
  "vue-cli-service": "@vue/cli-service",
  ng: "@angular/cli",
  nest: "@nestjs/cli",
  sb: "storybook",
  "electron-rebuild": "@electron/rebuild",
  playwright: "@playwright/test",
};

// Required peers consumed inside a framework/build tool rather than imported by application source.
// These contracts are package-scope local and deliberately narrow; declaring the provider is required
// for suppression, so an unrelated app still gets the normal unused-dependency finding.
const FRAMEWORK_RUNTIME_PEERS = new Map([
  ["next", ["react-dom"]],
  ["vinext", ["@vitejs/plugin-react", "@vitejs/plugin-rsc", "react-server-dom-webpack", "vite"]],
  ["electron-vite", ["vite"]],
  ["@cloudflare/vite-plugin", ["vite", "wrangler"]],
]);

// Style preprocessors are compiler inputs rather than JavaScript imports. Their presence is proven by
// source extensions in the same package scope, so do not report them as unused merely because Vite,
// webpack, etc. load them internally. Keep this list to exact compiler/package contracts.
const IMPLICIT_STYLE_COMPILERS = new Map([
  ["sass", /\.(?:scss|sass)$/i],
  ["sass-embedded", /\.(?:scss|sass)$/i],
  ["less", /\.less$/i],
  ["stylus", /\.styl(?:us)?$/i],
]);

const isStylesheetSpecifier = (spec) => /\.(?:css|scss|sass|less|styl(?:us)?)(?:[?#].*)?$/i.test(String(spec || ""));

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// word-ish mention: the name not embedded inside a longer identifier/path segment
const mentioned = (blob, name) => new RegExp(`(^|[^\\w@.-])${escRe(name)}($|[^\\w.-])`).test(blob);

// computeDepFindings({ externalImports, pkg, workspacePkgNames, configTexts }) → { findings, usedPackages }
//   externalImports — graph.json's array (P0): {file, spec, pkg, builtin, kind, line, dynamic?, unresolved?}
//   pkg             — parsed package.json ({} for non-JS repos → no dep findings)
//   workspacePkgNames — Set of monorepo-local package names (never "missing")
//   configTexts     — Map<fileName, text> of root config files + CI workflows (mention scanning)
export function computeDepFindings({
  externalImports = [], pkg = {}, workspacePkgNames = new Set(), configTexts = new Map(),
  aliases = [], scope = "", manifest = "package.json", nonRuntimeRoots = [], sourceFiles = [],
} = {}) {
  const findings = [];
  const meta = { scope: scope || ".", manifest };
  const isAliasSpec = (spec) => aliases.some((a) => {
    const s = String(spec || "");
    const key = typeof a === "string" ? a : String(a?.key || "");
    const prefix = typeof a === "string" ? a.replace(/\*.*$/, "") : String(a?.prefix || "");
    const suffix = key.includes("*") ? key.slice(key.indexOf("*") + 1) : String(a?.suffix || "");
    return key.includes("*")
      ? !!prefix && s.startsWith(prefix) && (!suffix || s.endsWith(suffix))
      : !!key && s === key;
  });
  const sections = {
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
    peerDependencies: pkg.peerDependencies || {},
    optionalDependencies: pkg.optionalDependencies || {},
  };
  const allDeclared = new Set(Object.values(sections).flatMap((s) => Object.keys(s)));
  const selfName = String(pkg.name || "");
  const normRoots = (nonRuntimeRoots || []).map((root) => String(root || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "")).filter(Boolean);
  const isNonRuntimeFile = (file) => {
    const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
    return normRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  };
  const npmNameParts = (name) => {
    const value = String(name || "");
    const slash = value.startsWith("@") ? value.indexOf("/") : -1;
    return slash > 0 ? { scope: value.slice(0, slash), base: value.slice(slash + 1) } : { scope: "", base: value };
  };
  const selfParts = npmNameParts(selfName);
  const configuredNapi = npmNameParts(pkg.napi?.name || selfName);
  const napiBinding = {
    scope: configuredNapi.scope || (configuredNapi.base === selfParts.base ? selfParts.scope : ""),
    base: configuredNapi.base,
  };
  const NAPI_PLATFORM_SUFFIX = /^(?:android-(?:arm64|arm-eabi)|win32-(?:x64|ia32|arm64)-msvc|darwin-(?:universal|x64|arm64)|freebsd-(?:x64|arm64)|linux-(?:x64|arm64|arm|riscv64|s390x|ppc64|loong64)-(?:gnu|musl|gnueabihf|musleabihf)|aix-ppc64|sunos-x64|wasm32-wasi(?:-preview1-threads)?)$/;
  const isGeneratedNapiPackage = (name, files) => {
    if (!pkg.napi || !napiBinding.base || !files.every((file) => /(^|\/)index\.[cm]?js$/i.test(String(file || "").replace(/\\/g, "/")))) return false;
    const candidate = npmNameParts(name);
    if (candidate.scope !== napiBinding.scope || !candidate.base.startsWith(`${napiBinding.base}-`)) return false;
    return NAPI_PLATFORM_SUFFIX.test(candidate.base.slice(napiBinding.base.length + 1));
  };
  const isGeneratedNapiBinary = (entry) => !!pkg.napi
    && /(^|\/)index\.[cm]?js$/i.test(String(entry.file || "").replace(/\\/g, "/"))
    && /^\.\/[^/]+\.node$/i.test(String(entry.spec || ""));
  // Some frameworks consume required peers internally, so application source legitimately never imports
  // them. Keep this deliberately narrow: react-dom is a required Next.js runtime peer in the same package
  // scope, not a general React exemption and not a repo-wide whitelist.
  const frameworkRuntime = new Set();
  for (const [provider, peers] of FRAMEWORK_RUNTIME_PEERS) {
    if (allDeclared.has(provider)) for (const peer of peers) frameworkRuntime.add(peer);
  }
  const implicitCompilerUsage = new Set();
  for (const [name, sourcePattern] of IMPLICIT_STYLE_COMPILERS) {
    if (allDeclared.has(name) && sourceFiles.some((file) => sourcePattern.test(String(file || "")))) {
      implicitCompilerUsage.add(name);
    }
  }

  // ---- usage index from the graph's recorded imports ----
  const usedPackages = new Map(); // pkgName -> { files:Set, lines:Map(file→first line), kinds/specs:Set, typeOnly:boolean }
  let builtinUsed = false;
  for (const e of externalImports) {
    if (e.ecosystem && e.ecosystem !== "npm") continue; // go/python imports have their own checkers
    if (isAliasSpec(e.spec)) continue;
    if (e.unresolved) continue;
    if (e.builtin) { builtinUsed = true; continue; }
    if (!e.pkg) continue;
    let u = usedPackages.get(e.pkg);
    if (!u) usedPackages.set(e.pkg, (u = { files: new Set(), lines: new Map(), kinds: new Set(), specs: new Set(), typeOnly: true }));
    u.files.add(e.file);
    if (!u.lines.has(e.file)) u.lines.set(e.file, e.line || 0);
    u.kinds.add(e.kind);
    u.specs.add(e.spec || e.pkg);
    if (!e.typeOnly) u.typeOnly = false;
  }

  const scriptBlob = Object.values(pkg.scripts || {}).join("\n");
  const configBlob = scriptBlob + "\n" + [...configTexts.values()].join("\n");
  const scriptTokens = new Set(scriptBlob.split(/[^\w@/.:-]+/).filter(Boolean));
  const binReferenced = (name) => {
    if (scriptTokens.has(name)) return true;
    for (const [bin, p] of Object.entries(BIN_PKG)) if (p === name && scriptTokens.has(bin)) return true;
    return false;
  };
  const typesBase = (name) => (name.startsWith("@types/") ? name.slice(7).replace(/^(.+?)__(.+)$/, "@$1/$2") : null); // @types/babel__core → @babel/core

  // ---- unused dependencies (per section; prod vs dev differ in severity/confidence) ----
  for (const [section, deps] of Object.entries(sections)) {
    if (section === "peerDependencies") continue; // peers are consumer-facing contracts, not usage
    for (const name of Object.keys(deps)) {
      if (name === selfName || usedPackages.has(name) || frameworkRuntime.has(name) || implicitCompilerUsage.has(name)) continue;
      const tb = typesBase(name);
      if (tb) { // @types/x is used iff x is used (or it types the Node builtins)
        if (tb === "node" ? builtinUsed : usedPackages.has(tb) || frameworkRuntime.has(tb) || mentioned(configBlob, tb)) continue;
      }
      if (binReferenced(name) || mentioned(configBlob, name)) continue; // scripts/config keep it alive
      const ecosystem = CONFIG_ECOSYSTEM_RE.test(name);
      const dev = section !== "dependencies";
      if (ecosystem && dev) continue; // config-convention devDeps: too FP-prone to flag at all
      findings.push(makeFinding({
        category: "unused",
        rule: "unused-dep",
        severity: dev ? "info" : "low",
        confidence: dev || ecosystem ? "low" : "medium",
        title: `Unused ${section === "dependencies" ? "dependency" : section.replace(/ies$/, "y")}: ${name}`,
        reason: "No recorded package import, package-script command, recognized config mention, framework peer contract, or implicit style-compiler input uses this declaration.",
        detail: `"${name}" is declared in ${section} but never imported in source, never referenced by a script, and not mentioned in any known config file. Dynamic/config-convention usage can't be fully ruled out — review before removing.`,
        package: name,
        source: "internal",
        fixHint: `npm uninstall ${name} (after confirming no config/CLI usage)`,
        ...meta,
      }));
    }
  }

  // ---- missing (phantom) dependencies: imported but declared nowhere ----
  for (const [name, use] of usedPackages) {
    if (allDeclared.has(name) || name === selfName || workspacePkgNames.has(name)) continue;
    const files = [...use.files];
    if (files.every(isNonRuntimeFile) || isGeneratedNapiPackage(name, files)) continue;
    const testOnly = files.every((f) => /(^|[/\\])(test|tests|__tests__|spec|e2e|__mocks__)([/\\]|$)|[._-](test|spec)\.[a-z]+$/i.test(f));
    const stylesheetOnly = [...use.specs].length > 0 && [...use.specs].every(isStylesheetSpecifier);
    const usageReason = stylesheetOnly
      ? `Direct stylesheet import(s) resolve through "${name}"; CSS-only imports are build/runtime inputs even without JavaScript bindings.`
      : use.typeOnly
        ? `Direct type-only import(s) resolve through "${name}"; the compiler still requires a declared package.`
        : `Direct source import(s) resolve through "${name}", but the nearest package manifest does not declare it.`;
    findings.push(makeFinding({
      category: "unused",
      rule: "missing-dep",
      severity: testOnly ? "low" : "medium",
      confidence: "high",
      title: `Missing dependency: ${name}`,
      reason: usageReason,
      detail: `"${name}" is imported by ${files.length} file(s) in scope ${meta.scope} but not declared in ${manifest} — it only works via a transitive install (phantom dependency) and can break on any lockfile change.`,
      package: name,
      file: files[0],
      line: use.lines.get(files[0]) || 0,
      evidence: files.slice(0, 5).map((f) => ({ file: f, line: use.lines.get(f) || 0, snippet: "" })),
      source: "internal",
      fixHint: `npm install ${testOnly ? "--save-dev " : ""}${name}`,
      ...meta,
    }));
  }

  // ---- duplicate declarations (same package in several sections) ----
  const seenIn = new Map();
  for (const [section, deps] of Object.entries(sections)) for (const name of Object.keys(deps)) (seenIn.get(name) || seenIn.set(name, []).get(name)).push(section);
  for (const [name, ss] of seenIn) {
    if (ss.length < 2) continue;
    if (ss.includes("peerDependencies") && ss.includes("devDependencies") && ss.length === 2) continue; // standard lib-author pattern
    findings.push(makeFinding({
      category: "unused",
      rule: "duplicate-dep",
      severity: "info",
      confidence: "high",
      title: `Duplicate declaration: ${name}`,
      reason: `The same package is declared in multiple manifest sections: ${ss.join(" + ")}.`,
      detail: `"${name}" is declared in ${ss.join(" + ")} — npm resolves one of them; keep a single section.`,
      package: name,
      source: "internal",
      ...meta,
    }));
  }

  // ---- unresolved local imports (broken relative/alias paths) ----
  const unresolvedSeen = new Set();
  let unresolvedCount = 0;
  for (const e of externalImports) {
    if (!e.unresolved) continue;
    if (isNonRuntimeFile(e.file) || isGeneratedNapiBinary(e)) continue;
    unresolvedCount++;
    const key = e.file + "|" + e.spec;
    if (unresolvedSeen.has(key) || unresolvedSeen.size >= 100) continue; // cap the findings, keep the count honest
    unresolvedSeen.add(key);
    findings.push(makeFinding({
      category: "structure",
      rule: "unresolved-import",
      severity: "low",
      confidence: "medium",
      title: `Unresolved import: ${e.spec}`,
      detail: `${e.file}:${e.line} imports "${e.spec}", which resolves to no file in the repo (broken path, missing alias target, or a file type the graph doesn't index).`,
      file: e.file,
      line: e.line || 0,
      source: "internal",
      ...meta,
    }));
  }
  if (unresolvedCount > unresolvedSeen.size) {
    findings.push(makeFinding({
      category: "structure",
      rule: "unresolved-import",
      severity: "info",
      confidence: "high",
      title: `…and ${unresolvedCount - unresolvedSeen.size} more unresolved imports`,
      detail: "Finding list capped at 100 unique unresolved imports; the count above is the true total.",
      source: "internal",
      ...meta,
    }));
  }

  return { findings, usedPackages, declared: allDeclared };
}

const normScope = (root) => String(root || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
const ownsFile = (scope, file) => !scope || file === scope || String(file || "").startsWith(`${scope}/`);

// Judge every import against its nearest ancestor package.json. This is the dependency equivalent of
// Node's package scope and prevents nested Next/Vite apps from inheriting the root manifest by accident.
export function computeScopedDepFindings({
  externalImports = [], packageScopes = [], workspacePkgNames = new Set(), configTexts = new Map(),
  nonRuntimeRoots = [], sourceFiles = [],
} = {}) {
  const scopes = packageScopes.length
    ? packageScopes.map((s) => ({ ...s, root: normScope(s.root) })).sort((a, b) => b.root.length - a.root.length)
    : [{ root: "", manifest: "package.json", pkg: {}, aliases: [] }];
  const importsByScope = new Map(scopes.map((s) => [s, []]));
  const sourceFilesByScope = new Map(scopes.map((s) => [s, []]));
  for (const e of externalImports) {
    const owner = scopes.find((s) => ownsFile(s.root, e.file)) || scopes[scopes.length - 1];
    importsByScope.get(owner).push(e);
  }
  for (const file of sourceFiles) {
    const owner = scopes.find((s) => ownsFile(s.root, file)) || scopes[scopes.length - 1];
    sourceFilesByScope.get(owner).push(file);
  }
  const configOwner = new Map();
  for (const [file] of configTexts) configOwner.set(file, scopes.find((scope) => ownsFile(scope.root, file)) || scopes[scopes.length - 1]);
  const findings = [], usedPackages = new Map(), declared = new Set();
  for (const s of scopes) {
    const scopeConfig = new Map([...configTexts].filter(([f]) => configOwner.get(f) === s));
    const r = computeDepFindings({
      externalImports: importsByScope.get(s), pkg: s.pkg || {}, workspacePkgNames, configTexts: scopeConfig,
      aliases: s.aliases || [], scope: s.root, manifest: s.manifest || (s.root ? `${s.root}/package.json` : "package.json"),
      nonRuntimeRoots, sourceFiles: sourceFilesByScope.get(s),
    });
    findings.push(...r.findings);
    for (const [name, use] of r.usedPackages) usedPackages.set(`${s.root || "."}:${name}`, use);
    for (const name of r.declared) declared.add(`${s.root || "."}:${name}`);
  }
  return { findings, usedPackages, declared };
}

export { computeGoDepFindings, computePyDepFindings } from "./dep-check-ecosystems.js";
