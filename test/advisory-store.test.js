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
  assert.equal(store.meta.repos["C:/a"], store.meta.fetched_at);
  rmSync(dir, { recursive: true, force: true });
});

test("advisory-store: missing/corrupt store loads as empty; refresh without fetch errors cleanly", async () => {
  const empty = loadStore(join(tmpdir(), "weavatrix-does-not-exist", "x.json"));
  assert.equal(empty.meta.fetched_at, null);
  assert.deepEqual(queryStore(empty, "npm", "anything"), []);
  const r = await refreshAdvisories({ installed: [], storePath: join(tmpdir(), "x.json"), fetcher: null });
  assert.equal(r.ok, false);
});

test("advisory-store: refresh queries npm, PyPI, and Go; unsupported ecosystems are skipped", async () => {
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
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.queried, 3);
    assert.equal(r.unsupported, 1);
    assert.deepEqual(seen.sort(), ["Go:golang.org/x/net@0.20.0", "PyPI:requests@2.31.0", "npm:lodash@4.17.20"]);
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
