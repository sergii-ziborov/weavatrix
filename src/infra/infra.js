// Infrastructure / backing-service detection. graph-builder's graph.json only contains code FILES and
// symbols, so the GUI board's external-service towers were inferred purely from FILE PATHS
// (relIsDb + a name-regex). That misses any datastore whose connector file isn't literally named
// after it — e.g. a service that `import`s @clickhouse/client from services/metrics.js, or wires
// Influx through a logging helper. This module reads the REAL high-signal sources instead:
//   1. dependency manifests   (package.json / go.mod / requirements.txt / pom.xml / build.gradle /
//                              Cargo.toml / *.csproj / Gemfile / composer.json)  — most reliable
//   2. container/orchestration (docker-compose / Dockerfile / k8s manifests) — image names
//   3. env / config            (.env*, k8s env:) — variable-NAME conventions (KEYS ONLY, never values)
//   4. source imports          — to attribute each service to its connector file(s) for the io edges
// and matches them against a curated signature registry → a structured list of services the repo
// talks to, each with kind/name/colour + the files that connect to it.
//
// PRIVACY: env files are read for KEY NAMES only (the part before `=`); values are never parsed,
// stored, logged, or returned. Secrets in .env stay in .env.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// Concrete infra-item extraction + the shared leaf helpers (lc / safeRead / size caps) live in infra-items.js.
import { collectInfraItems, itemMetaFor, safeRead, lc, IMPORT_SCAN_MAX_FILES, MAX_FILE_BYTES } from "./infra-items.js";

// ---- signature registry ----
// One row per backing service, loaded from infra-registry.js (generated + adversarially verified by the
// infra-signature-registry workflow). Matching is DETERMINISTIC token comparison (no free-form regex over
// arbitrary text), so false positives stay near zero:
//   deps        — exact manifest dependency names; token T matches dep D when D===T or D starts with T/ T: T@.
//   images      — docker image repo names, matched by path-segment SUFFIX ("redis" hits "bitnami/redis";
//                 "mongo" misses "mongo-express").
//   envPrefixes — UPPERCASE env-var KEY prefixes; token P matches key K when K===P or K starts with P_.
//                 Prefixes listed in envWeak only count when the key ALSO ends in an infra suffix
//                 (HOST/URL/DSN/PORT/BROKER/…), so DATABASE_URL-style keys can't over-fire.
//   imports     — quoted substrings in source import/require lines; used to attribute connector files.
// kind ∈ db|ts|cache|queue|cloud|api|fs|logs — drives the GUI board tower glyph/colour (GUI core KCFG).
import { INFRA_SERVICES } from "./infra-registry.js";
export { INFRA_SERVICES };

// ---- scanning bounds (mirror apimap.js) ---------------------------------------------------------
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", "coverage", "vendor",
  ".venv", "venv", "env", "target", "__pycache__", ".idea", ".vscode", ".cache", "bin", "obj",
]);
const CODE_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".java", ".kt", ".rb", ".php", ".cs", ".scala", ".rs",
]);
const MAX_FILES = 60000;
// graph-analysis IPC stays responsive on large repos — detection itself (manifests/images/env) is unaffected

// env-var name suffixes that, when a generic prefix carries one, confirm it really configures a
// backing service (so PG_/DATABASE_/S3_/ES_ only fire on PG_HOST, DATABASE_URL, S3_BUCKET, …).
const ENV_SUFFIX = /_(HOSTS?|URLS?|URI|DSN|PORTS?|ADDR|ADDRESS(ES)?|BROKERS?|SERVERS?|ENDPOINTS?|CONN|CONNECTION(S)?|DB|DATABASE|PASS(WORD)?|USER(NAME)?|SECRET|TOPICS?|BUCKETS?|REGION|GROUP|CLUSTER|NAMESPACE|REPLICA(SET)?|MEASUREMENT|TLS|SSL|KEY|TOKEN)$/;

// ---- matchers (exported for unit tests) ---------------------------------------------------------
export function depMatches(manifestDep, token) {
  const m = lc(manifestDep), d = lc(token);
  if (!m || !d) return false;
  return m === d || m.startsWith(d + "/") || m.startsWith(d + ":") || m.startsWith(d + "@");
}

// strip registry host + tag + digest → bare repo path (lowercased)
export function normImageRepo(ref) {
  let s = String(ref || "").trim().replace(/^['"]|['"]$/g, "");
  if (!s) return "";
  const at = s.indexOf("@");
  if (at >= 0) s = s.slice(0, at); // strip @sha256:...
  const slash = s.lastIndexOf("/");
  const lastSeg = s.slice(slash + 1);
  const colon = lastSeg.indexOf(":"); // tag lives only in the last path segment (host may have :port)
  if (colon >= 0) s = s.slice(0, slash + 1) + lastSeg.slice(0, colon);
  return lc(s);
}
// repo path-segments end with the token's segments (so "redis" hits "bitnami/redis", "mongo" misses "mongo-express")
export function imageMatches(repoSegs, token) {
  const t = lc(token).split("/").filter(Boolean);
  if (!t.length || t.length > repoSegs.length) return false;
  for (let i = 1; i <= t.length; i++) if (repoSegs[repoSegs.length - i] !== t[t.length - i]) return false;
  return true;
}

export function envMatches(key, token, weak) {
  const K = String(key || "").toUpperCase(), P = String(token || "").toUpperCase();
  if (!K || !P) return false;
  if (K !== P && !K.startsWith(P + "_")) return false;
  if (weak) {
    if (K === P) return false; // a bare generic prefix alone proves nothing
    if (!ENV_SUFFIX.test(K.slice(P.length))) return false; // require an infra-ish suffix
  }
  return true;
}

// ---- manifest dependency extraction -------------------------------------------------------------

// Returns a Set of dependency token strings pulled from one manifest file. PROD deps only where the
// format distinguishes them (package.json/composer.json), so test-only clients (ioredis-mock,
// mongodb-memory-server, testcontainers) don't manufacture a phantom service.
// test doubles / in-memory fakes / emulators — these pull in a client name but mean "this is tested
// against a fake", not "depends on the live service". Never let them register a backing service.
const DEV_DOUBLE = /(-mock|_mock|mock-|fake|memory-server|inmemory|testcontainers|-local$|localstack|azurite)/i;

export function depsFromManifest(name, text) {
  const out = new Set();
  const add = (v) => { const s = String(v || "").trim(); if (s && !DEV_DOUBLE.test(s)) out.add(s); };
  const low = name.toLowerCase();
  try {
    if (low === "package.json") {
      const j = JSON.parse(text);
      for (const sect of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        if (j[sect] && typeof j[sect] === "object") for (const k of Object.keys(j[sect])) add(k);
      }
    } else if (low === "composer.json") {
      const j = JSON.parse(text);
      if (j.require && typeof j.require === "object") for (const k of Object.keys(j.require)) add(k);
    } else if (low === "go.mod") {
      // `require x.y/z v1` and `require ( … )` blocks
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[0-9]/gim)) add(m[1]);
    } else if (low === "go.sum") {
      for (const m of text.matchAll(/^([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[0-9]/gim)) add(m[1]);
    } else if (low === "requirements.txt" || low === "constraints.txt") {
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9._-]+)/);
        if (m && !line.trim().startsWith("#")) add(m[1]);
      }
    } else if (low === "pipfile" || low === "pyproject.toml" || low === "cargo.toml") {
      // TOML dependency tables — pull bare `name = ...` keys and array-of-strings `"name>=x"`.
      for (const m of text.matchAll(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*=/gm)) add(m[1]);
      for (const m of text.matchAll(/["']([A-Za-z0-9._-]+)\s*[<>=~!^*]/g)) add(m[1]);
    } else if (low === "pom.xml") {
      // pair each <artifactId> with the nearest preceding <groupId> → group:artifact AND bare artifact
      const re = /<groupId>\s*([^<]+?)\s*<\/groupId>\s*<artifactId>\s*([^<]+?)\s*<\/artifactId>/g;
      let m;
      while ((m = re.exec(text))) { add(`${m[1]}:${m[2]}`); add(m[2]); }
      for (const a of text.matchAll(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/g)) add(a[1]);
    } else if (low.endsWith(".gradle") || low.endsWith(".gradle.kts")) {
      // implementation('group:artifact:ver') / "group:artifact:ver"
      for (const m of text.matchAll(/["']([A-Za-z0-9._-]+:[A-Za-z0-9._-]+)(?::[^"']*)?["']/g)) { add(m[1]); add(m[1].split(":")[1]); }
    } else if (low.endsWith(".csproj") || low === "packages.config" || low.endsWith(".fsproj")) {
      for (const m of text.matchAll(/(?:PackageReference|package)\s+(?:Include|id)\s*=\s*"([^"]+)"/gi)) add(m[1]);
    } else if (low === "gemfile") {
      for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gim)) add(m[1]);
    }
  } catch {
    /* malformed manifest — skip */
  }
  return out;
}

const MANIFEST_NAMES = new Set([
  "package.json", "composer.json", "go.mod", "go.sum", "requirements.txt", "constraints.txt",
  "pipfile", "pyproject.toml", "cargo.toml", "pom.xml", "packages.config", "gemfile",
]);
const isManifest = (name) => {
  const n = name.toLowerCase();
  return MANIFEST_NAMES.has(n) || n.endsWith(".gradle") || n.endsWith(".gradle.kts") || n.endsWith(".csproj") || n.endsWith(".fsproj");
};
const isComposeFile = (name) => /^(docker-)?compose([.-].*)?\.ya?ml$/i.test(name);
const isDockerfile = (name) => /^dockerfile(\..+)?$/i.test(name) || /\.dockerfile$/i.test(name);
const isYaml = (name) => /\.ya?ml$/i.test(name);

// ---- the scan -----------------------------------------------------------------------------------
function scanRepo(repoPath) {
  const deps = new Set();         // manifest dependency tokens
  const imageRefs = [];           // normalized image repo paths
  const envKeys = new Set();      // UPPERCASE env-var names (keys only)
  const codeFiles = [];           // { path(rel, fwd-slash), full } for the import pass
  const manifests = new Set();    // which manifest kinds were seen (for diagnostics)

  let count = 0;
  const stack = [repoPath];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(cur, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (++count > MAX_FILES) break;
      const name = entry.name;
      const full = join(cur, name);
      const rel = full.slice(repoPath.length).replace(/^[\\/]/, "").replace(/\\/g, "/");

      if (isManifest(name)) {
        manifests.add(name.toLowerCase());
        for (const d of depsFromManifest(name, safeRead(full))) deps.add(d);
        continue;
      }
      if (/^\.env(\..+)?$/i.test(name)) {
        const text = safeRead(full);
        // KEYS ONLY — split on the first '=' and keep the left side; never read the value.
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          if (m) envKeys.add(m[1].toUpperCase());
        }
        continue;
      }
      const dockery = isComposeFile(name) || isDockerfile(name);
      if (dockery || isYaml(name)) {
        const text = safeRead(full);
        if (!text) continue;
        const k8sLike = /(^|\n)\s*kind:\s*\S/.test(text) && /(^|\n)\s*(image|env):/.test(text);
        if (!dockery && !k8sLike) continue; // a random *.yaml that isn't a manifest — skip
        for (const m of text.matchAll(/(?:^|\n)\s*(?:-\s*)?image:\s*["']?([^\s"']+)/gi)) imageRefs.push(normImageRepo(m[1]));
        for (const m of text.matchAll(/(?:^|\n)\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)/gi)) imageRefs.push(normImageRepo(m[1]));
        // env var NAMES: k8s `- name: KEY`, compose `KEY: value` / `- KEY=value`, Dockerfile `ENV KEY`
        for (const m of text.matchAll(/\bname:\s*["']?([A-Z_][A-Z0-9_]{2,})\b/g)) envKeys.add(m[1].toUpperCase());
        for (const m of text.matchAll(/(?:^|\n)\s*(?:-\s*)?([A-Z_][A-Z0-9_]{2,})\s*[:=]/g)) envKeys.add(m[1].toUpperCase());
        continue;
      }
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
      if (CODE_EXT.has(ext)) codeFiles.push({ path: rel, full });
    }
    if (count > MAX_FILES) break;
  }
  const imageSegs = imageRefs.filter(Boolean).map((r) => ({ raw: r, segs: r.split("/").filter(Boolean) }));
  return { deps, imageSegs, envKeys, codeFiles, manifests: [...manifests] };
}

// ---- detection ----------------------------------------------------------------------------------
export function detectInfraFromScan(scan, registry = INFRA_SERVICES) {
  const found = new Map(); // id → { service, signals:Set, sources:Set, importTokens:[] }
  const note = (svc, signal, source) => {
    let e = found.get(svc.id);
    if (!e) found.set(svc.id, (e = { service: svc, signals: new Set(), sources: new Set(), importTokens: [] }));
    if (signal) e.signals.add(signal);
    if (source) e.sources.add(source);
  };

  for (const svc of registry) {
    // 1) manifest deps (highest confidence)
    for (const tok of svc.deps || []) {
      for (const d of scan.deps) { if (depMatches(d, tok)) { note(svc, `dep:${d}`, "manifest"); break; } }
    }
    // 2) container images
    for (const tok of svc.images || []) {
      for (const im of scan.imageSegs) { if (imageMatches(im.segs, tok)) { note(svc, `image:${im.raw}`, "image"); break; } }
    }
    // 3) env-var name conventions
    const weakSet = new Set((svc.envWeak || []).map((s) => s.toUpperCase()));
    for (const tok of svc.envPrefixes || []) {
      for (const k of scan.envKeys) { if (envMatches(k, tok, weakSet.has(tok.toUpperCase()))) { note(svc, `env:${k}`, "env"); break; } }
    }
  }

  // 4) source imports → attribute connector files (and a weak detection signal). Only scan if any
  // service has import tokens; pre-filter files by a combined token regex (cheap), like apimap.
  const importIndex = []; // { svc, token }
  for (const svc of registry) for (const tok of svc.imports || []) importIndex.push({ svc, tok: lc(tok) });
  const filesByService = new Map(); // id → Set(relPath)
  if (importIndex.length && scan.codeFiles.length) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pre = new RegExp(importIndex.map((x) => esc(x.tok)).join("|"), "i");
    // Reading every source file is the only O(repo-size) cost here and it runs synchronously, so cap it:
    // connector-file attribution is best-effort and detection from manifests/images/env is already complete
    // above. ~5k files keeps the cold scan well under a second even on a large monorepo (then it's cached).
    const scanFiles = scan.codeFiles.length > IMPORT_SCAN_MAX_FILES ? scan.codeFiles.slice(0, IMPORT_SCAN_MAX_FILES) : scan.codeFiles;
    for (const f of scanFiles) {
      const text = safeRead(f.full);
      if (!text || text.length > MAX_FILE_BYTES || !pre.test(text)) continue;
      const lcText = text.toLowerCase();
      for (const { svc, tok } of importIndex) {
        // require a quoted/pathish occurrence so a stray word doesn't match: 'tok' "tok" `tok` tok/ tok"
        if (lcText.includes(`"${tok}`) || lcText.includes(`'${tok}`) || lcText.includes("`" + tok) || lcText.includes(`/${tok}"`) || lcText.includes(tok + "/")) {
          let set = filesByService.get(svc.id);
          if (!set) filesByService.set(svc.id, (set = new Set()));
          set.add(f.path);
          // imports alone also count as a (weaker) detection signal
          if (!found.has(svc.id)) note(svc, `import:${tok}`, "import");
          else found.get(svc.id).sources.add("import");
        }
      }
    }
  }

  const entries = [...found.values()];
  const itemsByService = collectInfraItems(scan, entries, filesByService);
  const services = entries.map(({ service, signals, sources }) => {
    const files = [...(filesByService.get(service.id) || [])].sort().slice(0, 40);
    const itemData = itemsByService.get(service.id) || { ...itemMetaFor(service), items: [] };
    // confidence: a parsed manifest dep or image is hard evidence; env/import alone is softer.
    const hard = sources.has("manifest") || sources.has("image");
    const confidence = hard ? "high" : sources.has("env") && sources.has("import") ? "high" : sources.has("env") || sources.has("import") ? "medium" : "low";
    return {
      id: service.id, name: service.name, kind: service.kind, color: service.color,
      confidence, sources: [...sources].sort(), signals: [...signals].sort().slice(0, 24), files,
      items: itemData.items || [], itemLabel: itemData.itemLabel || itemData.label, unit: itemData.unit || "",
    };
  });
  // stable, useful order: hard evidence first, then by source count, then name
  const rank = (c) => (c === "high" ? 0 : c === "medium" ? 1 : 2);
  services.sort((a, b) => rank(a.confidence) - rank(b.confidence) || b.signals.length - a.signals.length || a.name.localeCompare(b.name));
  return services;
}

// ---- public API (cached by manifest/compose/env mtime) ------------------------------------------
const _cache = new Map(); // repoPath → { sig, result }

// cheap cache signature: newest mtime among the files that drive detection. If none change, reuse.
function repoSignature(repoPath) {
  let newest = 0, seen = 0;
  const probe = (p) => { try { const st = statSync(p); if (st.isFile()) { newest = Math.max(newest, st.mtimeMs); seen++; } } catch { /* missing — skip */ } };
  const roots = ["package.json", "go.mod", "go.sum", "requirements.txt", "pyproject.toml", "Pipfile", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", ".env", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "Dockerfile", "skaffold.yaml"];
  for (const r of roots) probe(join(repoPath, r));
  for (const dir of ["k8s", "kubernetes", "deploy", "manifests", "helm", "charts", ".github"]) {
    try { for (const e of readdirSync(join(repoPath, dir), { withFileTypes: true })) if (e.isFile()) probe(join(repoPath, dir, e.name)); } catch { /* no such dir */ }
  }
  return `${seen}:${Math.round(newest)}`;
}

// Detect the backing services a repo talks to. Cheap & cached; safe to call from repos:graph-analysis.
export function detectInfra(repoPath, opts = {}) {
  if (!repoPath || !existsSync(repoPath)) return { ok: false, error: "Repo path not found", services: [] };
  const sig = repoSignature(repoPath);
  const cached = _cache.get(repoPath);
  if (!opts.force && cached && cached.sig === sig) return cached.result;
  let result;
  try {
    const scan = scanRepo(repoPath);
    const services = detectInfraFromScan(scan);
    result = { ok: true, services, scanned: { manifests: scan.manifests, codeFiles: scan.codeFiles.length, envKeys: scan.envKeys.size, images: scan.imageSegs.length } };
  } catch (error) {
    result = { ok: false, error: error.message, services: [] };
  }
  _cache.set(repoPath, { sig, result });
  return result;
}
