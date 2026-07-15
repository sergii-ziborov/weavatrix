// Signature detection + cached public API for infrastructure detection. Split out of infra.js
// (which remains the public facade); see that file's header for the pipeline overview and the
// registry/matching contract documented next to the INFRA_SERVICES re-export.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// Concrete infra-item extraction + the shared leaf helpers (lc / safeRead / size caps) live in infra-items.js.
import { collectInfraItems, itemMetaFor, safeRead, lc, IMPORT_SCAN_MAX_FILES, MAX_FILE_BYTES } from "./infra-items.js";
import { INFRA_SERVICES } from "./infra-registry.js";
import { depMatches, imageMatches, envMatches } from "./infra.match.js";
import { scanRepo } from "./infra.scan.js";

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
