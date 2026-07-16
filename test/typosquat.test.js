// typosquat — Damerau-Levenshtein + classifier over the bundled top-package list (P6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { damerau, classifyTyposquat, TOP_PACKAGES } from "../src/security/typosquat.js";

test("damerau: substitution/insertion/deletion + adjacent transposition", () => {
  assert.equal(damerau("lodash", "lodash"), 0);
  assert.equal(damerau("lodahs", "lodash"), 1); // transposition (sh↔hs) = 1, not 2
  assert.equal(damerau("expres", "express"), 1); // deletion
  assert.equal(damerau("expresss", "express"), 1); // insertion
  assert.equal(damerau("axois", "axios"), 1); // transposition
});

test("classifyTyposquat: catches classic lures", () => {
  assert.equal(classifyTyposquat("crossenv")?.nearest, "cross-env"); // the famous one (missing hyphen)
  assert.equal(classifyTyposquat("lodahs")?.nearest, "lodash");
  assert.equal(classifyTyposquat("expresss")?.nearest, "express");
  assert.equal(classifyTyposquat("axois")?.nearest, "axios");
  assert.equal(classifyTyposquat("reactt")?.nearest, "react");
});

test("classifyTyposquat: legit popular names + known pairs are NOT flagged", () => {
  for (const name of ["react", "lodash", "express", "cross-env", "cross-spawn", "react-dom", "mysql2", "bcryptjs"]) {
    assert.equal(classifyTyposquat(name), null, `${name} should be clean`);
  }
  assert.equal(classifyTyposquat("query-string"), null, "query-string is a legitimate package, not querystring bait");
  assert.equal(classifyTyposquat("querystring"), null);
  // scope-only difference of a popular name is not a squat
  assert.equal(classifyTyposquat("@myorg/react"), null);
});

test("classifyTyposquat: unrelated + very-short names ignored", () => {
  assert.equal(classifyTyposquat("my-internal-thing"), null);
  assert.equal(classifyTyposquat("totally-unique-pkg-xyz"), null);
  assert.equal(classifyTyposquat("abc"), null); // <4 chars
  assert.equal(classifyTyposquat("fs"), null);
});

test("classifyTyposquat: distance-2 only for longer names", () => {
  // short name (chalk = 5), distance 2 → ignored (too collision-prone)
  assert.equal(damerau("chxlq", "chalk"), 2);
  assert.equal(classifyTyposquat("chxlq"), null);
  // long name (typescript = 10 chars), distance 2 → flagged
  assert.equal(damerau("typoscrapt", "typescript"), 2);
  const hit = classifyTyposquat("typoscrapt");
  assert.ok(hit && hit.nearest === "typescript", `expected typescript, got ${JSON.stringify(hit)}`);
});
