// Local advisory cache for supply-chain scanning. SCANS are 100% offline (read this store only);
// REFRESH is an explicit, user-triggered online call to OSV.dev (it necessarily sends the installed
// package names+versions — surfaced in the UI, never automatic). OSV is the single source: CVE/GHSA
// vulnerabilities AND OSSF malicious-package records (MAL-*) come through one schema/one matcher.
//
// Storage is a JSON file, not SQLite — deliberate P4 deviation from the plan: we cache advisories for
// THIS machine's installed packages (hundreds of records), not the full npm snapshot (that's what
// needed SQLite), and better-sqlite3 here is built for Electron's ABI so plain-node tests couldn't
// load it. Same API surface; swap to SQLite if/when a full baked snapshot ships (P6).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_STORE = join(homedir(), ".weavatrix", "advisories.json");
const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns/";
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.WEAVATRIX_OSV_TIMEOUT_MS || 20000);
export const OSV_SUPPORTED_ECOSYSTEMS = new Set(["npm", "PyPI", "Go"]);

const keyOf = (ecosystem, name) => `${ecosystem}|${ecosystem === "PyPI" ? String(name).toLowerCase().replace(/[-_.]+/g, "-") : name}`;

function uniquePackages(pkgs) {
  const seen = new Set();
  return pkgs.filter((p) => {
    const k = `${p.ecosystem}|${p.name}|${p.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function fetchJson(fetcher, url, options, timeoutMs) {
  const timeout = Math.max(50, Number(timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS);
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const request = fetcher(url, ctrl ? { ...options, signal: ctrl.signal } : options);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { ctrl?.abort(); } catch { /* ignore */ }
        reject(new Error(`OSV request timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
    });
    const res = await Promise.race([request, timeoutPromise]);
    if (!res || typeof res.json !== "function") throw new Error("invalid response from OSV");
    if (res.ok === false) throw new Error(`HTTP ${res.status || "error"} from OSV`);
    return await res.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`OSV request timed out after ${Math.round(timeout / 1000)}s`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function loadStore(storePath = DEFAULT_STORE) {
  try {
    const s = JSON.parse(readFileSync(storePath, "utf8"));
    if (s && typeof s === "object" && s.records) return s;
  } catch { /* missing/corrupt → empty */ }
  return { meta: { fetched_at: null }, records: {} };
}

export function queryStore(store, ecosystem, name) {
  return (store && store.records && store.records[keyOf(ecosystem, name)]) || [];
}

export function storeMeta(storePath = DEFAULT_STORE) {
  const s = loadStore(storePath);
  return { fetchedAt: s.meta?.fetched_at || null, advisoryCount: Object.values(s.records || {}).reduce((n, l) => n + l.length, 0) };
}

// GHSA-style labels + CVSS score → our severity scale. MAL-* records are always critical.
function severityOf(rec) {
  if (String(rec.id || "").startsWith("MAL-")) return "critical";
  const label = String(rec.database_specific?.severity || "").toLowerCase();
  if (label === "critical") return "critical";
  if (label === "high") return "high";
  if (label === "moderate" || label === "medium") return "medium";
  if (label === "low") return "low";
  let best = 0;
  for (const s of rec.severity || []) {
    const m = String(s.score || "").match(/CVSS:[\d.]+\/.*?\bA[VC]?:/i) ? null : String(s.score || "").match(/^(\d+(\.\d+)?)$/);
    if (m) best = Math.max(best, Number(m[1]));
  }
  if (best >= 9) return "critical";
  if (best >= 7) return "high";
  if (best >= 4) return "medium";
  return "medium"; // unknown → medium, never silently info
}

// One normalized row per (record × matching affected entry): everything the matcher/UI needs, nothing else.
function normalizeRecord(rec, ecosystem, name) {
  const affected = (rec.affected || []).find((a) => a?.package && a.package.ecosystem === ecosystem && keyOf(ecosystem, a.package.name) === keyOf(ecosystem, name));
  if (!affected) return null;
  const fixed = [];
  for (const r of affected.ranges || []) for (const e of r.events || []) if (e.fixed) fixed.push(e.fixed);
  return {
    id: rec.id,
    kind: String(rec.id || "").startsWith("MAL-") ? "malicious" : "vuln",
    severity: severityOf(rec),
    summary: String(rec.summary || rec.details || "").slice(0, 300),
    url: `https://osv.dev/vulnerability/${rec.id}`,
    modified: rec.modified || "",
    aliases: (rec.aliases || []).slice(0, 6),
    fixedIn: [...new Set(fixed)].slice(0, 4),
    affected: { versions: affected.versions || [], ranges: affected.ranges || [] },
  };
}

// Refresh the cache from OSV for the given installed set. fetcher is injectable for tests.
// Returns { queried, vulnerable, fetched, saved, errors }.
export async function refreshAdvisories({ installed = [], storePath = DEFAULT_STORE, fetcher = globalThis.fetch, batchSize = 100, repoKey = "", repoKeys = [], timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetcher !== "function") return { ok: false, error: "no fetch available" };
  const withVersions = installed.filter((p) => p && p.ecosystem && p.name && p.version);
  const unsupported = withVersions.filter((p) => !OSV_SUPPORTED_ECOSYSTEMS.has(p.ecosystem)).length;
  const pkgs = uniquePackages(withVersions.filter((p) => OSV_SUPPORTED_ECOSYSTEMS.has(p.ecosystem)));
  if (!pkgs.length) {
    return {
      ok: false,
      queried: 0,
      unsupported,
      error: "No OSV-supported pinned package versions found to check. weavatrix currently queries OSV for npm, PyPI, and Go packages with concrete versions.",
    };
  }
  const store = loadStore(storePath);
  const idsByPkg = new Map(); // pkgIndex -> [vuln ids]
  const errors = [];

  for (let i = 0; i < pkgs.length; i += batchSize) {
    const batch = pkgs.slice(i, i + batchSize);
    try {
      const json = await fetchJson(fetcher, OSV_BATCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: batch.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version })) }),
      }, timeoutMs);
      (json.results || []).forEach((r, j) => { if (r && Array.isArray(r.vulns) && r.vulns.length) idsByPkg.set(i + j, r.vulns.map((v) => v.id)); });
    } catch (error) {
      errors.push(`querybatch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pkgs.length / batchSize)}: ${error.message}`);
    }
  }

  const wanted = new Map(); // id -> [pkg,...] (an id can hit several packages)
  for (const [pi, ids] of idsByPkg) for (const id of ids) (wanted.get(id) || wanted.set(id, []).get(id)).push(pkgs[pi]);

  let fetched = 0;
  for (const [id, pkgList] of wanted) {
    try {
      const rec = await fetchJson(fetcher, OSV_VULN_URL + encodeURIComponent(id), {}, timeoutMs);
      if (!rec || !rec.id) continue;
      fetched++;
      for (const p of pkgList) {
        const row = normalizeRecord(rec, p.ecosystem, p.name);
        if (!row) continue;
        const key = keyOf(p.ecosystem, p.name);
        const list = store.records[key] || (store.records[key] = []);
        const at = list.findIndex((x) => x.id === row.id);
        if (at >= 0) list[at] = row; else list.push(row);
      }
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
    }
  }

  // A refresh where NOTHING was fetched but errors occurred (offline, OSV blocked) must NOT stamp
  // fetched_at — that would turn an empty cache into "No known vulnerabilities as of <today>".
  if (errors.length && fetched === 0 && (idsByPkg.size === 0 || wanted.size > 0)) {
    return { ok: false, queried: pkgs.length, unsupported, error: `advisory refresh failed: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`, errors };
  }
  store.meta.fetched_at = new Date().toISOString();
  // per-repo stamp: the cache only covers packages that were QUERIED — a repo that never refreshed must
  // show "fetch advisories", not "0 vulnerabilities as of <someone else's date>" (false assurance).
  // repoKeys[] lets one online pass (a "refresh all repos") stamp every repo whose packages it covered.
  const stampRepos = [...new Set([repoKey, ...repoKeys].filter(Boolean))];
  if (stampRepos.length) { store.meta.repos = store.meta.repos || {}; for (const k of stampRepos) store.meta.repos[k] = store.meta.fetched_at; }
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(store), "utf8");
  } catch (error) {
    return { ok: false, error: `store write failed: ${error.message}`, errors };
  }
  return { ok: true, queried: pkgs.length, unsupported, vulnerable: wanted.size, fetched, saved: existsSync(storePath), errors };
}
