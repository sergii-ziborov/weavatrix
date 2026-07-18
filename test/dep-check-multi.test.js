// Go + Python dependency findings (dep-check.js computeGoDepFindings / computePyDepFindings) —
// set math over ecosystem-tagged externalImports vs go.mod / python manifests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGoDepFindings, computePyDepFindings } from "../src/analysis/dep-check.js";

const goImp = (spec, pkg, file = "main.go", extra = {}) => ({ file, spec, pkg, builtin: false, kind: "go-import", line: 3, ecosystem: "Go", ...extra });
const pyImp = (spec, pkg, file = "app.py", extra = {}) => ({ file, spec, pkg, builtin: false, kind: "py-import", line: 2, ecosystem: "PyPI", ...extra });

test("go: direct-unused flagged, indirect + used + replaced never flagged; missing detected", () => {
  const goMod = {
    module: "github.com/acme/speaker",
    requires: [
      { path: "github.com/segmentio/kafka-go", version: "v0.4.47", indirect: false },
      { path: "github.com/unused/dep", version: "v1.0.0", indirect: false },
      { path: "golang.org/x/sys", version: "v0.15.0", indirect: true },
    ],
    replaces: [{ from: "github.com/replaced/mod", to: "../local" }],
  };
  const externalImports = [
    goImp("github.com/segmentio/kafka-go/sasl", "github.com/segmentio/kafka-go"), // used via subpackage
    goImp("github.com/not/declared", "github.com/not/declared"),
    goImp("github.com/replaced/mod/pkg", "github.com/replaced/mod"),
    goImp("fmt", "fmt", "main.go", { builtin: true }),
  ];
  const { findings } = computeGoDepFindings({ externalImports, goMod });
  const unused = findings.filter((f) => f.rule === "unused-dep").map((f) => f.package);
  const missing = findings.filter((f) => f.rule === "missing-dep").map((f) => f.package);
  assert.deepEqual(unused, ["github.com/unused/dep"]);
  assert.deepEqual(missing, ["github.com/not/declared"]); // replaced module suppressed
  assert.ok(findings.every((finding) => finding.reason), "every Go dependency finding explains its confidence basis");
});

test("go: no go.mod → no findings (can't judge)", () => {
  const { findings } = computeGoDepFindings({ externalImports: [goImp("github.com/a/b", "github.com/a/b")], goMod: null });
  assert.equal(findings.length, 0);
});

test("py: alias (yaml→PyYAML) and python-X naming suppress unused; CLI tools + stubs skipped", () => {
  const pyManifest = { present: true, deps: [
    { name: "PyYAML", dev: false },
    { name: "python-dateutil", dev: false },
    { name: "pytest", dev: true },          // CLI tool — never unused
    { name: "types-requests", dev: true },  // stubs — never unused
    { name: "leftover-lib", dev: false },   // truly unused
  ] };
  const externalImports = [
    pyImp("yaml", "PyYAML"),
    pyImp("dateutil.parser", "python-dateutil"),
  ];
  const { findings } = computePyDepFindings({ externalImports, pyManifest });
  assert.deepEqual(findings.map((f) => [f.rule, f.package]), [["unused-dep", "leftover-lib"]]);
  assert.match(findings[0].reason, /mapping.*heuristic/i);
  assert.equal(findings[0].confidence, "low"); // import↔dist mapping is heuristic — never higher
});

test("py: missing dep found with dist-name hint; test-only imports downgraded; no-manifest softened", () => {
  const imports = [
    pyImp("requests", "requests"),
    pyImp("cv2", "opencv-python", "tests/test_vision.py"),
  ];
  const withManifest = computePyDepFindings({ externalImports: imports, pyManifest: { present: true, deps: [] } });
  const req = withManifest.findings.find((f) => f.package === "requests");
  const cv = withManifest.findings.find((f) => f.package === "opencv-python");
  assert.equal(req.severity, "medium");
  assert.match(req.reason, /no declared distribution covers it/);
  assert.equal(cv.severity, "low"); // test-only
  assert.match(cv.fixHint, /pip install opencv-python/);
  const noManifest = computePyDepFindings({ externalImports: imports, pyManifest: { present: false, deps: [] } });
  assert.ok(noManifest.findings.every((f) => f.severity === "low" && f.confidence === "low"));
});

test("py: config mention keeps a declared dep alive (tox/setup.cfg text)", () => {
  const pyManifest = { present: true, deps: [{ name: "celery", dev: false }] };
  const configTexts = new Map([["tox.ini", "[testenv]\ncommands = celery worker -A app"]]);
  const { findings } = computePyDepFindings({ externalImports: [], pyManifest, configTexts });
  assert.equal(findings.length, 0);
});

test("py: managed-runtime and explicitly ignored dependencies are not called accidental environment leaks", () => {
  const externalImports = [pyImp("numpy", "numpy"), pyImp("openvino_genai", "openvino-genai"), pyImp("vendor_sdk", "vendor-sdk")];
  const { findings, managed } = computePyDepFindings({
    externalImports,
    pyManifest: { present: false, deps: [] },
    managedDependencies: ["numpy", "openvino-genai"],
    ignoredDependencies: ["vendor-sdk"],
  });
  assert.equal(findings.length, 0);
  assert.deepEqual([...managed].sort(), ["numpy", "openvino-genai"]);
});

test("Go and Python dependency checks ignore declared non-runtime template roots only", () => {
  const nonRuntimeRoots = ["templates", "library"];
  const go = computeGoDepFindings({
    goMod: { module: "example.test/app", requires: [], replaces: [] },
    nonRuntimeRoots,
    externalImports: [
      goImp("github.com/example/template", "github.com/example/template", "templates/go/main.go"),
      goImp("github.com/example/runtime", "github.com/example/runtime", "cmd/server/main.go"),
    ],
  });
  assert.deepEqual(go.findings.filter((finding) => finding.rule === "missing-dep").map((finding) => finding.package), ["github.com/example/runtime"]);

  const py = computePyDepFindings({
    pyManifest: { present: false, deps: [] },
    nonRuntimeRoots,
    externalImports: [
      pyImp("django", "django", "library/components/View.py"),
      pyImp("requests", "requests", "src/client.py"),
    ],
  });
  assert.deepEqual(py.findings.filter((finding) => finding.rule === "missing-dep").map((finding) => finding.package), ["requests"]);
});

test("Python dependency checks use the nearest nested manifest without leaking it to sibling code", () => {
  const pyManifest = {
    present: true,
    deps: [{name: "slack_bolt", dev: false}],
    scopes: [{
      root: "autobot",
      present: true,
      manifests: ["autobot/requirements.txt"],
      deps: [{name: "slack_bolt", dev: false, manifest: "autobot/requirements.txt"}],
    }],
  };
  const result = computePyDepFindings({
    pyManifest,
    externalImports: [
      pyImp("slack_bolt", "slack_bolt", "autobot/autobot.py"),
      pyImp("slack_bolt", "slack_bolt", "other/tool.py"),
    ],
  });
  const missing = result.findings.filter((finding) => finding.rule === "missing-dep");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].file, "other/tool.py");
  assert.equal(missing[0].severity, "low", "a sibling without a Python manifest remains unknown, not falsely covered");
});

test("root test.py imports are classified as test-only dependency evidence", () => {
  const result = computePyDepFindings({
    pyManifest: {present: true, deps: []},
    externalImports: [pyImp("requests", "requests", "test.py")],
  });
  assert.equal(result.findings[0].severity, "low");
});
