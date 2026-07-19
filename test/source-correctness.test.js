import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSourceCorrectness } from "../src/analysis/source-correctness.js";

const analyze = (files) => analyzeSourceCorrectness(new Map(Object.entries(files)));
const rules = (result) => result.findings.map((finding) => finding.rule);

test("source correctness flags a fixed-bound Go slice only when no earlier length guard is visible", () => {
  const result = analyze({
    "unsafe.go": "package p\nfunc Header(payload []byte) []byte { return payload[:4] }\n",
    "guarded.go": "package p\nfunc Header(payload []byte) []byte { if len(payload) < 4 { return nil }; return payload[:4] }\n",
  });
  const findings = result.findings.filter((finding) => finding.rule === "go-unguarded-fixed-slice");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "unsafe.go");
  assert.equal(findings[0].confidence, "high");
});

test("source correctness recognizes a Go constructor/discriminator copy-paste mismatch", () => {
  const result = analyze({
    "flow.go": [
      "package p",
      "const FLOW_SPEC_TYPE_LABEL = 1",
      "const FLOW_SPEC_TYPE_DSCP = 2",
      "type Spec struct { Type int }",
      "func NewLabel() Spec { return Spec{Type: FLOW_SPEC_TYPE_DSCP} }",
    ].join("\n"),
  });
  const finding = result.findings.find((item) => item.rule === "constructor-enum-mismatch");
  assert.ok(finding);
  assert.match(finding.detail, /FLOW_SPEC_TYPE_LABEL/);
  assert.match(finding.title, /FLOW_SPEC_TYPE_DSCP/);
});

test("source correctness reports swallowed Java interruption but accepts restore or rethrow", () => {
  const result = analyze({
    "Worker.java": [
      "class Worker {",
      "  void swallowed() { try { run(); } catch (InterruptedException error) { log(error); } }",
      "  void restored() { try { run(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } }",
      "  void propagated() throws InterruptedException { try { run(); } catch (InterruptedException error) { throw error; } }",
      "}",
    ].join("\n"),
  });
  const findings = result.findings.filter((finding) => finding.rule === "java-interrupt-status-not-restored");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.match(findings[0].detail, /helper may restore/i);
});

test("source correctness emits a bounded review signal for an unconditional retry loop", () => {
  const result = analyze({
    "retry.js": "export function connect() { while (true) { attempts++; retry(); } }\n",
    "bounded.js": "export function connect() { while (true) { attempts++; if (attempts >= maxAttempts) break; retry(); } }\n",
    "commented.js": "// while (true) { retry(); }\nexport const ok = true;\n",
    "commented.py": "while True:\n    work()  # retry is handled by the caller\n",
  });
  const findings = result.findings.filter((finding) => finding.rule === "unbounded-retry-loop");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "retry.js");
  assert.equal(findings[0].confidence, "medium");
  assert.match(findings[0].detail, /review signal, not proof/i);
  assert.ok(!rules(result).includes("race-condition"));
});

test("source correctness reviews conditional and do/while Java retry loops without a bound", () => {
  const result = analyze({
    "ApplicationHealthCheck.java": [
      "class ApplicationHealthCheck { void start() {",
      "boolean allSet = false;",
      "while (!allSet) { try { checkAll(); allSet = true; } catch (Exception error) { sleep(waitMs); } }",
      "} }",
    ].join("\n"),
    "POHandler.java": [
      "class POHandler { void load() { boolean isError = false; int total = 0;",
      "do { try { loadPage(); } catch (Exception error) { isError = true; sleep(2000); } }",
      "while (isError || total == 0);",
      "} }",
    ].join("\n"),
    "Bounded.java": "class Bounded { void load() { while (attempts < maxAttempts) { tryLoad(); retry(); } } }",
  });
  const findings = result.findings.filter((finding) => finding.rule === "unbounded-retry-loop");
  assert.deepEqual(findings.map((finding) => finding.file).sort(), ["ApplicationHealthCheck.java", "POHandler.java"]);
  assert.ok(findings.every((finding) => /review signal, not proof/i.test(finding.detail)));
});
