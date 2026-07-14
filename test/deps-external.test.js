// deps-external adapter parsers — knip/depcheck/depcruise text reports → unified Findings (P3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKnip, parseDepcheck, parseDepcruise } from "../src/tools/deps-external.js";

test("parseKnip: sections map to rules; entries keep name/file split", () => {
  const out = [
    "Unused files (2)",
    "src/old/legacy.ts",
    "src/tmp.ts",
    "Unused dependencies (1)",
    "lodash  package.json",
    "Unlisted dependencies (1)",
    "mongodb  src/db.ts",
    "Unused exports (1)",
    "src/util.ts:12:14  leftover",
  ].join("\n");
  const f = parseKnip(out);
  const byRule = (r) => f.filter((x) => x.rule === r);
  assert.equal(byRule("unused-file").length, 2);
  assert.equal(byRule("unused-file")[0].file, "src/old/legacy.ts");
  assert.equal(byRule("unused-dep")[0].package, "lodash");
  assert.equal(byRule("missing-dep")[0].package, "mongodb");
  assert.equal(byRule("unused-export")[0].file, "src/util.ts");
  assert.ok(f.every((x) => x.source === "knip"));
});

test("parseDepcheck: unused prod/dev + missing with using-file", () => {
  const out = [
    "Unused dependencies",
    "* nan",
    "Unused devDependencies",
    "* left-pad",
    "Missing dependencies",
    "* mongodb: ./services/mongoClient.js",
  ].join("\n");
  const f = parseDepcheck(out);
  assert.equal(f.length, 3);
  assert.equal(f[0].package, "nan");
  assert.equal(f[0].severity, "low");
  assert.equal(f[1].severity, "info");
  const missing = f.find((x) => x.rule === "missing-dep");
  assert.equal(missing.package, "mongodb");
  assert.equal(missing.file, "services/mongoClient.js");
});

test("parseDepcruise: circular chain collected; severity from level; comment line not swallowed", () => {
  const out = [
    "  warn no-circular: services/a.js → ",
    "      services/b.js →",
    "      services/a.js",
    "    Circular dependency — refactor to break the cycle.",
    "  error no-orphans: services/lost.js",
    "    Orphan module.",
    "",
    "x 2 dependency violations (1 errors, 1 warnings). 10 modules cruised.",
  ].join("\n");
  const f = parseDepcruise(out);
  assert.equal(f.length, 2);
  const cyc = f.find((x) => x.rule === "circular-dep");
  assert.equal(cyc.severity, "medium");
  assert.match(cyc.detail, /services\/a\.js → services\/b\.js → services\/a\.js/);
  const orp = f.find((x) => x.rule === "orphan-file");
  assert.equal(orp.severity, "high");
  assert.equal(orp.file, "services/lost.js");
});
