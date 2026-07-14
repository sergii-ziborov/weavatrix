// Pure OSV advisory matcher — installed {ecosystem,name,version} × advisory affected[] → hits.
// From-scratch lite version comparator (semver-ish + PyPI epoch), NO deps. Exact `versions[]`
// membership is preferred (confidence high); range evaluation is the fallback (confidence medium) —
// per DEPS_SECURITY_PLAN P4: when unsure, label lower confidence rather than guessing "vulnerable".
export function parseVersion(v) {
  let s = String(v || "").trim().replace(/^[v=]/, "");
  let epoch = 0;
  const em = s.match(/^(\d+)!(.*)$/); // PyPI epoch "1!2.0"
  if (em) { epoch = Number(em[1]); s = em[2]; }
  s = s.split("+")[0]; // build metadata never orders
  const dash = s.indexOf("-");
  const core = dash < 0 ? s : s.slice(0, dash);
  const pre = dash < 0 ? [] : s.slice(dash + 1).split(".").filter(Boolean);
  const nums = core.split(".").map((x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; });
  return { epoch, nums, pre };
}

export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] || 0, y = pb.nums[i] || 0;
    if (x !== y) return x - y;
  }
  if (!pa.pre.length && pb.pre.length) return 1;  // release > its pre-release
  if (pa.pre.length && !pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (nx !== ny) return nx ? -1 : 1; // numeric identifiers order before alphanumeric (semver)
    else { const c = x < y ? -1 : x > y ? 1 : 0; if (c) return c; }
  }
  return 0;
}

// affected = one OSV `affected[]` entry (already filtered to this package): {versions?, ranges?}.
// Returns { hit, by: "versions"|"range"|"range-open", confidence } — GIT ranges are skipped (commit
// hashes aren't comparable to release versions).
export function isVersionAffected(version, affected = {}) {
  if (Array.isArray(affected.versions) && affected.versions.length) {
    const norm = String(version).replace(/^v/, "");
    if (affected.versions.some((x) => String(x).replace(/^v/, "") === norm)) return { hit: true, by: "versions", confidence: "high" };
    // NOT a short-circuit: OSV's enumerated versions[] is often incomplete while ranges[] stays
    // authoritative (that's what the server-side querybatch matches on). Falling through to the
    // ranges below is what stops "querybatch flagged it, but re-analysis shows 0 vulnerabilities".
  }
  for (const r of affected.ranges || []) {
    if (!r || r.type === "GIT") continue;
    let active = false;
    for (const e of r.events || []) { // OSV spec: events are sorted
      if (e.introduced !== undefined) {
        active = e.introduced === "0" || compareVersions(version, e.introduced) >= 0;
      } else if (e.fixed !== undefined) {
        if (active && compareVersions(version, e.fixed) < 0) return { hit: true, by: "range", confidence: "medium" };
        active = false;
      } else if (e.last_affected !== undefined) {
        if (active && compareVersions(version, e.last_affected) <= 0) return { hit: true, by: "range", confidence: "medium" };
        active = false;
      }
    }
    if (active) return { hit: true, by: "range-open", confidence: "medium" }; // introduced, never fixed
  }
  return { hit: false };
}

// installed: [{ecosystem,name,version,...}]; queryFn(ecosystem, name) → normalized advisory rows
// [{id, kind: "vuln"|"malicious", severity, summary, url, affected}]. Dedup by (advisory id, package).
export function matchAdvisories(installed, queryFn) {
  const hits = [];
  const seen = new Set();
  for (const pkg of installed || []) {
    for (const adv of queryFn(pkg.ecosystem, pkg.name) || []) {
      const key = `${adv.id}|${pkg.name}|${pkg.version}`;
      if (seen.has(key)) continue;
      const m = isVersionAffected(pkg.version, adv.affected || {});
      if (!m.hit) continue;
      seen.add(key);
      hits.push({ pkg, adv, matchedBy: m.by, confidence: m.confidence });
    }
  }
  return hits;
}
