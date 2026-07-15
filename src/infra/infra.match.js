// Deterministic matchers + manifest dependency extraction for infrastructure detection.
// Split out of infra.js (which remains the public facade); see that file's header for the full
// detection pipeline and the registry/matching contract.
import { lc } from "./infra-items.js";

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
