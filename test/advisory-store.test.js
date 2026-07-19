// security/advisory-store — refresh with a mocked OSV fetcher, offline query, end-to-end match (P4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshAdvisories, loadStore, queryStore, storeMeta } from "../src/security/advisory-store.js";
import { matchAdvisories } from "../src/security/match.js";

const LODASH_REC = {
  id: "GHSA-35jh-r3h4-6jhm",
  summary: "Command injection in lodash",
  modified: "2022-01-01T00:00:00Z",
  aliases: ["CVE-2021-23337"],
  database_specific: { severity: "HIGH" },
  affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
};
const MAL_REC = {
  id: "MAL-2024-0001",
  summary: "malicious code in evil-pkg",
  modified: "2024-01-01T00:00:00Z",
  aliases: [],
  affected: [{ package: { ecosystem: "npm", name: "evil-pkg" }, versions: ["1.0.0"] }],
};

function fakeFetcher(url, opts) {
  if (String(url).endsWith("/querybatch")) {
    const { queries } = JSON.parse(opts.body);
    const results = queries.map((q) =>
      q.package.name === "lodash" ? { vulns: [{ id: LODASH_REC.id }] } : q.package.name === "evil-pkg" ? { vulns: [{ id: MAL_REC.id }] } : {});
    return Promise.resolve({ json: async () => ({ results }) });
  }
  const id = decodeURIComponent(String(url).split("/").pop());
  const rec = id === LODASH_REC.id ? LODASH_REC : id === MAL_REC.id ? MAL_REC : null;
  return Promise.resolve({ json: async () => rec || {} });
}

test("advisory-store: refresh caches normalized records; offline query + match find both kinds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-"));
  const storePath = join(dir, "advisories.json");
  const installed = [
    { ecosystem: "npm", name: "lodash", version: "4.17.20", source: "package-lock" },
    { ecosystem: "npm", name: "evil-pkg", version: "1.0.0", source: "package-lock" },
    { ecosystem: "npm", name: "clean-pkg", version: "2.0.0", source: "package-lock" },
  ];
  const r = await refreshAdvisories({ installed, storePath, fetcher: fakeFetcher });
  assert.equal(r.ok, true);
  assert.equal(r.queried, 3);
  assert.equal(r.vulnerable, 2);
  assert.equal(r.fetched, 2);

  const meta = storeMeta(storePath);
  assert.equal(meta.advisoryCount, 2);
  assert.ok(meta.fetchedAt);

  // fully OFFLINE from here: load + query + match, no fetcher involved
  const store = loadStore(storePath);
  const lodashRows = queryStore(store, "npm", "lodash");
  assert.equal(lodashRows.length, 1);
  assert.equal(lodashRows[0].severity, "high");
  assert.deepEqual(lodashRows[0].fixedIn, ["4.17.21"]);

  const hits = matchAdvisories(installed, (eco, name) => queryStore(store, eco, name));
  assert.equal(hits.length, 2);
  assert.equal(hits.find((h) => h.pkg.name === "lodash").adv.kind, "vuln");
  assert.equal(hits.find((h) => h.pkg.name === "evil-pkg").adv.kind, "malicious");
  assert.equal(hits.find((h) => h.pkg.name === "evil-pkg").adv.severity, "critical");

  // a fixed lodash stops matching
  const fixed = [{ ecosystem: "npm", name: "lodash", version: "4.17.21", source: "package-lock" }];
  assert.equal(matchAdvisories(fixed, (eco, name) => queryStore(store, eco, name)).length, 0);

  rmSync(dir, { recursive: true, force: true });
});

test("advisory-store: repoKeys[] stamps every covered repo in one refresh (the cross-repo DB update)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-all-"));
  const storePath = join(dir, "advisories.json");
  const r = await refreshAdvisories({
    installed: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }],
    storePath, fetcher: fakeFetcher, repoKeys: ["C:/a", "C:/b", "C:/a"], // dupes collapse
  });
  assert.equal(r.ok, true);
  const store = loadStore(storePath);
  assert.deepEqual(Object.keys(store.meta.repos).sort(), ["C:/a", "C:/b"]);
  assert.equal(store.meta.repos["C:/a"].fetched_at, store.meta.fetched_at);
  assert.equal(store.meta.repos["C:/a"].status, "OK");
  assert.match(store.meta.repos["C:/a"].query_fingerprint, /^[a-f0-9]{64}$/);
  rmSync(dir, { recursive: true, force: true });
});

test("advisory-store: missing/corrupt store loads as empty; refresh without fetch errors cleanly", async () => {
  const empty = loadStore(join(tmpdir(), "weavatrix-does-not-exist", "x.json"));
  assert.equal(empty.meta.fetched_at, null);
  assert.deepEqual(queryStore(empty, "npm", "anything"), []);
  const r = await refreshAdvisories({ installed: [], storePath: join(tmpdir(), "x.json"), fetcher: null });
  assert.equal(r.ok, false);
});

test("advisory-store: refresh queries npm, PyPI, Go, Maven, and crates.io", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-ecos-"));
  const storePath = join(dir, "advisories.json");
  const seen = [];
  const fetcher = async (url, opts) => {
    assert.ok(String(url).endsWith("/querybatch"));
    const { queries } = JSON.parse(opts.body);
    seen.push(...queries.map((q) => `${q.package.ecosystem}:${q.package.name}@${q.version}`));
    return { ok: true, json: async () => ({ results: queries.map(() => ({})) }) };
  };
  try {
    const r = await refreshAdvisories({
      storePath,
      fetcher,
      installed: [
        { ecosystem: "npm", name: "lodash", version: "4.17.20" },
        { ecosystem: "PyPI", name: "requests", version: "2.31.0" },
        { ecosystem: "Go", name: "golang.org/x/net", version: "0.20.0" },
        { ecosystem: "Maven", name: "org.example:demo", version: "1.0.0" },
        { ecosystem: "crates.io", name: "serde", version: "1.0.210" },
        { ecosystem: "NuGet", name: "Example", version: "1.0.0" },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.queried, 5);
    assert.equal(r.unsupported, 1);
    assert.deepEqual(seen.sort(), ["Go:golang.org/x/net@0.20.0", "Maven:org.example:demo@1.0.0", "PyPI:requests@2.31.0", "crates.io:serde@1.0.210", "npm:lodash@4.17.20"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("advisory-store: OSV request timeout returns a clean failure and does not stamp the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-timeout-"));
  const storePath = join(dir, "advisories.json");
  try {
    const r = await refreshAdvisories({
      storePath,
      timeoutMs: 50,
      fetcher: () => new Promise(() => {}),
      installed: [{ ecosystem: "npm", name: "left-pad", version: "1.3.0" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
    assert.equal(loadStore(storePath).meta.fetched_at, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("advisory-store: partial OSV coverage is persisted as PARTIAL, never certified OK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-partial-"));
  const storePath = join(dir, "advisories.json");
  const repoKey = "C:/partial-repo";
  const fetcher = async (url, opts) => {
    if (!String(url).endsWith("/querybatch")) return fakeFetcher(url, opts);
    const { queries } = JSON.parse(opts.body);
    if (queries[0].package.name === "broken-pkg") throw new Error("batch unavailable");
    return fakeFetcher(url, opts);
  };
  try {
    const result = await refreshAdvisories({
      storePath, repoKey, batchSize: 1, fetcher,
      installed: [
        { ecosystem: "npm", name: "lodash", version: "4.17.20" },
        { ecosystem: "npm", name: "broken-pkg", version: "1.0.0" },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.queriedOk, 1);
    assert.equal(loadStore(storePath).meta.repos[repoKey].status, "PARTIAL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("advisory-store: malformed or truncated OSV batch responses cannot certify coverage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-malformed-"));
  const storePath = join(dir, "advisories.json");
  try {
    const result = await refreshAdvisories({
      storePath,
      repoKey: "C:/malformed",
      installed: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }],
      fetcher: async () => ({ ok: true, json: async () => ({}) }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /returned no result/);
    assert.equal(loadStore(storePath).meta.fetched_at, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("advisory-store: malformed querybatch entries cannot certify a clean result", async () => {
  for (const [label, result] of [
    ["null result", null],
    ["non-array vulns", { vulns: "bad" }],
    ["missing advisory id", { vulns: [{}] }],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-batch-entry-"));
    const storePath = join(dir, "advisories.json");
    try {
      const refresh = await refreshAdvisories({
        storePath,
        repoKey: `C:/batch-${label.replace(/ /g, "-")}`,
        installed: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }],
        fetcher: async () => ({ ok: true, json: async () => ({ results: [result] }) }),
      });
      assert.equal(refresh.ok, false, label);
      assert.equal(loadStore(storePath).meta.fetched_at, null, label);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("advisory-store: malformed or unrelated advisory details remain PARTIAL", async () => {
  for (const [label, detail] of [
    ["missing id", { affected: LODASH_REC.affected }],
    ["wrong id", { ...LODASH_REC, id: "GHSA-wrong-detail" }],
    ["wrong package", { ...LODASH_REC, affected: [{ package: { ecosystem: "npm", name: "other-pkg" } }] }],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "weavatrix-adv-detail-"));
    const storePath = join(dir, "advisories.json");
    const repoKey = `C:/detail-${label.replace(/ /g, "-")}`;
    try {
      const result = await refreshAdvisories({
        storePath,
        repoKey,
        installed: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }],
        fetcher: async (url, opts) => String(url).endsWith("/querybatch")
          ? fakeFetcher(url, opts)
          : { ok: true, json: async () => detail },
      });
      assert.equal(result.ok, true, label);
      assert.equal(result.status, "PARTIAL", label);
      assert.equal(result.fetched, 0, label);
      assert.ok(result.errors.length, label);
      const store = loadStore(storePath);
      assert.equal(store.meta.repos[repoKey].status, "PARTIAL", label);
      assert.equal(queryStore(store, "npm", "lodash").length, 0, label);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
