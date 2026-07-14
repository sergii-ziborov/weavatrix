// security/installed — lockfile/requirements/go.sum parsers (pure) for the supply-chain scan (P4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePackageLock, parseYarnLock, parseRequirements, parseGoSum } from "../src/security/installed.js";

test("parsePackageLock v3: packages map, nested node_modules, scopes, dev flag", () => {
  const out = parsePackageLock({
    lockfileVersion: 3,
    packages: {
      "": { name: "root", version: "1.0.0" },
      "node_modules/axios": { version: "1.6.0", integrity: "sha512-a" },
      "node_modules/@scope/x": { version: "2.0.0", dev: true },
      "node_modules/a/node_modules/b": { version: "0.5.0" },
      "node_modules/native": { version: "1.0.0", hasInstallScript: true },
    },
  });
  // nested "node_modules/a/node_modules/b" keeps only the innermost package name "b"
  assert.deepEqual(out.map((p) => `${p.name}@${p.version}${p.dev ? ":dev" : ""}`).sort(), ["@scope/x@2.0.0:dev", "axios@1.6.0", "b@0.5.0", "native@1.0.0"].sort());
  assert.equal(out.find((p) => p.name === "native").hasInstallScript, true);
  assert.equal(out.find((p) => p.name === "axios").hasInstallScript, false);
});

test("parsePackageLock v1: recursive dependencies tree", () => {
  const out = parsePackageLock({
    dependencies: {
      express: { version: "4.18.0", dependencies: { accepts: { version: "1.3.8" } } },
    },
  });
  assert.deepEqual(out.map((p) => `${p.name}@${p.version}`).sort(), ["accepts@1.3.8", "express@4.18.0"]);
});

test("parseYarnLock: classic blocks incl. scoped packages", () => {
  const out = parseYarnLock(['"@scope/pkg@^1.0.0", "@scope/pkg@~1.2.0":', '  version "1.2.3"', "", "lodash@^4:", '  version "4.17.21"'].join("\n"));
  assert.deepEqual(out.map((p) => `${p.name}@${p.version}`).sort(), ["@scope/pkg@1.2.3", "lodash@4.17.21"]);
});

test("parseYarnLock: @npm: protocol + aliases resolve to the REAL package name (drift-drift fix)", () => {
  const out = parseYarnLock([
    '"react-is-18@npm:react-is@18.3.1":', '  version "18.3.1"', "",       // alias → react-is
    '"react-is@npm:^17.0.0":', '  version "17.0.2"', "",                    // npm protocol, non-aliased
    '"@scope/real@npm:@scope/other@2.0.0":', '  version "2.0.0"',           // scoped alias → @scope/other
  ].join("\n"));
  assert.deepEqual(out.map((p) => `${p.name}@${p.version}`).sort(), ["@scope/other@2.0.0", "react-is@17.0.2", "react-is@18.3.1"].sort());
});

test("parseRequirements: exact == and compatible-release ~= pins; loose >= skipped; PEP503 names", () => {
  const out = parseRequirements(["requests==2.31.0", "Django_Rest.Framework==3.14.0  # api", "urllib3~=1.26.8", "PyYAML~=5.4.1", "flask>=2.0", "boto3==1.0.*", "-r other.txt"].join("\n"));
  assert.deepEqual(out.map((p) => `${p.name}@${p.version}`), ["requests@2.31.0", "django-rest-framework@3.14.0", "urllib3@1.26.8", "pyyaml@5.4.1", "boto3@1.0"]);
});

test("parseGoSum: module versions without the v prefix; /go.mod lines skipped", () => {
  const out = parseGoSum(["github.com/gin-gonic/gin v1.9.1 h1:abc=", "github.com/gin-gonic/gin v1.9.1/go.mod h1:def=", "golang.org/x/net v0.17.0 h1:xyz="].join("\n"));
  assert.deepEqual(out.map((p) => `${p.name}@${p.version}`), ["github.com/gin-gonic/gin@1.9.1", "golang.org/x/net@0.17.0"]);
  assert.ok(out.every((p) => p.ecosystem === "Go"));
});
