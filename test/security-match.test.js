// security/match — version comparator + OSV affected-range evaluation (P4 core).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isVersionAffected, matchAdvisories } from "../src/security/match.js";

test("compareVersions: numeric segments, not lexicographic", () => {
  assert.ok(compareVersions("1.2.3", "1.10.0") < 0);
  assert.ok(compareVersions("2.0.0", "10.0.0") < 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.ok(compareVersions("v1.2.3", "1.2.2") > 0); // v-prefix tolerated
});

test("compareVersions: pre-releases order before the release; PyPI epoch dominates", () => {
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta") < 0);
  assert.ok(compareVersions("1.0.0-alpha.1", "1.0.0-alpha") > 0);
  assert.ok(compareVersions("1.0.0-2", "1.0.0-alpha") < 0); // numeric ids < alphanumeric ids
  assert.ok(compareVersions("1!1.0", "2.0") > 0); // epoch wins
  assert.equal(compareVersions("1.2.3+build5", "1.2.3"), 0); // build metadata ignored
});

test("isVersionAffected: exact versions[] wins with high confidence", () => {
  const affected = { versions: ["0.1.1", "0.1.2"] };
  assert.deepEqual(isVersionAffected("0.1.1", affected), { hit: true, by: "versions", confidence: "high" });
  assert.equal(isVersionAffected("0.1.3", affected).hit, false);
});

test("isVersionAffected: incomplete versions[] does NOT short-circuit a covering range", () => {
  // OSV enumerated versions[] can be stale/incomplete while ranges[] stays authoritative (querybatch
  // matches on the range) — the miss used to render as "0 vulnerabilities" after an online refresh.
  const affected = { versions: ["4.17.19"], ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] };
  assert.deepEqual(isVersionAffected("4.17.20", affected), { hit: true, by: "range", confidence: "medium" });
  assert.deepEqual(isVersionAffected("4.17.19", affected), { hit: true, by: "versions", confidence: "high" }); // exact list still wins
  assert.equal(isVersionAffected("4.17.21", affected).hit, false); // fixed → not affected
});

test("isVersionAffected: introduced/fixed windows, multiple pairs, last_affected, open range", () => {
  const twoWindows = { ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.2.0" }, { introduced: "2.0.0" }, { fixed: "2.1.0" }] }] };
  assert.equal(isVersionAffected("1.1.0", twoWindows).hit, true);
  assert.equal(isVersionAffected("1.5.0", twoWindows).hit, false); // between windows
  assert.equal(isVersionAffected("2.0.5", twoWindows).hit, true);
  assert.equal(isVersionAffected("2.1.0", twoWindows).hit, false); // fixed is exclusive

  const last = { ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { last_affected: "3.3.6" }] }] };
  assert.equal(isVersionAffected("3.3.6", last).hit, true); // last_affected is inclusive
  assert.equal(isVersionAffected("3.3.7", last).hit, false);

  const open = { ranges: [{ type: "SEMVER", events: [{ introduced: "4.0.0" }] }] };
  const r = isVersionAffected("4.9.9", open);
  assert.equal(r.hit, true);
  assert.equal(r.by, "range-open");

  const git = { ranges: [{ type: "GIT", events: [{ introduced: "abc123" }] }] };
  assert.equal(isVersionAffected("1.0.0", git).hit, false); // GIT ranges skipped
});

test("matchAdvisories: hits dedupe by (id, pkg); malicious rides through", () => {
  const installed = [
    { ecosystem: "npm", name: "lodash", version: "4.17.20", source: "package-lock" },
    { ecosystem: "npm", name: "flatmap-stream", version: "0.1.1", source: "package-lock" },
    { ecosystem: "npm", name: "safe-pkg", version: "1.0.0", source: "package-lock" },
  ];
  const advisories = {
    "npm|lodash": [{ id: "GHSA-x", kind: "vuln", severity: "high", summary: "proto pollution", url: "", aliases: [], fixedIn: ["4.17.21"], affected: { ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] } }],
    "npm|flatmap-stream": [{ id: "MAL-1", kind: "malicious", severity: "critical", summary: "trojan", url: "", aliases: [], fixedIn: [], affected: { versions: ["0.1.1", "0.1.2"] } }],
  };
  const hits = matchAdvisories(installed, (eco, name) => advisories[`${eco}|${name}`] || []);
  assert.equal(hits.length, 2);
  const mal = hits.find((h) => h.adv.kind === "malicious");
  assert.equal(mal.pkg.name, "flatmap-stream");
  assert.equal(mal.confidence, "high"); // exact versions[] match
});
