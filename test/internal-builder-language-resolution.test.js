import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildInternalGraph} from '../src/graph/internal-builder.js'

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rl-build-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative)
    mkdirSync(join(full, '..'), {recursive: true})
    writeFileSync(full, content)
  }
  return dir
}

test("internal-builder: Python receiver types and wildcard imports resolve without mixing same-named methods", async () => {
  const dir = repoWith({
    "pkg/__init__.py": "",
    "pkg/alpha.py": "class AlphaService:\n    def run(self):\n        return 'alpha'\n",
    "pkg/beta.py": "class BetaService:\n    def run(self):\n        return 'beta'\n",
    "pkg/helpers.py": "__all__ = ['wild_helper']\ndef wild_helper():\n    return 1\ndef hidden_helper():\n    return 2\n",
    "pkg/use.py":
      "from .alpha import AlphaService as Alpha\n" +
      "from .beta import BetaService\n" +
      "from .helpers import *\n" +
      "def use(alpha: Alpha, beta: BetaService):\n" +
      "    alpha.run()\n" +
      "    beta.run()\n" +
      "    local = Alpha()\n" +
      "    local.run()\n" +
      "    return wild_helper()\n",
  });
  try {
    const graph = await buildInternalGraph(dir);
    const symbol = (file, name, line) => graph.nodes.find((node) => node.source_file === file
      && String(node.id).includes(`#${name}@`) && (!line || node.source_location === `L${line}`));
    const use = symbol("pkg/use.py", "use");
    const alphaRun = symbol("pkg/alpha.py", "run");
    const betaRun = symbol("pkg/beta.py", "run");
    const wildcard = symbol("pkg/helpers.py", "wild_helper");
    assert.equal(alphaRun.member_of, "AlphaService");
    assert.equal(betaRun.member_of, "BetaService");
    const calls = graph.links.filter((link) => link.source === use.id && link.relation === "calls");
    assert.equal(calls.filter((link) => link.target === alphaRun.id).length, 2, "typed alias and constructor binding resolve to AlphaService.run");
    assert.equal(calls.filter((link) => link.target === betaRun.id).length, 1, "typed receiver resolves only to BetaService.run");
    assert.equal(calls.filter((link) => link.target === wildcard.id).length, 1, "unique __all__ wildcard symbol resolves");
    assert.ok(calls.filter((link) => [alphaRun.id, betaRun.id, wildcard.id].includes(link.target)).every((link) => link.provenance === "RESOLVED"));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("internal-builder: Go receiver types resolve params, locals, constructors, and struct fields without same-name guesses", async () => {
  const dir = repoWith({
    "go.mod": "module example.test/app\n\ngo 1.22\n",
    "speaker/speaker.go": [
      "package speaker",
      "type Speaker struct{}",
      "type OtherSpeaker struct{}",
      "func (s *Speaker) RemoveMitigator(id string) {}",
      "func (s *OtherSpeaker) RemoveMitigator(id string) {}",
      "func NewSpeaker() *Speaker { return &Speaker{} }",
      "func New() (*Speaker, error) { return &Speaker{}, nil }",
    ].join("\n"),
    "cmd/main.go": [
      "package main",
      'import sp "example.test/app/speaker"',
      "type Holder struct { Bgp *sp.Speaker }",
      "func Run(param *sp.Speaker, other *sp.OtherSpeaker, holder *Holder, mystery interface{ RemoveMitigator(string) }) {",
      "  var local *sp.Speaker",
      "  var assigned = sp.NewSpeaker()",
      "  inferred := sp.NewSpeaker()",
      "  multi, err := sp.New()",
      "  _ = err",
      "  param.RemoveMitigator(\"param\")",
      "  local.RemoveMitigator(\"local\")",
      "  assigned.RemoveMitigator(\"assigned\")",
      "  inferred.RemoveMitigator(\"inferred\")",
      "  multi.RemoveMitigator(\"multi-result constructor\")",
      "  holder.Bgp.RemoveMitigator(\"field\")",
      "  other.RemoveMitigator(\"other\")",
      "  mystery.RemoveMitigator(\"dynamic\")",
      "}",
    ].join("\n"),
  });
  try {
    const graph = await buildInternalGraph(dir);
    const symbols = (file, name) => graph.nodes.filter((node) => node.source_file === file && node.label === `${name}()`);
    const run = symbols("cmd/main.go", "Run")[0];
    const methods = symbols("speaker/speaker.go", "RemoveMitigator");
    const speakerMethod = methods.find((node) => node.member_of === "Speaker");
    const otherMethod = methods.find((node) => node.member_of === "OtherSpeaker");
    assert.equal(speakerMethod.receiver_type, "Speaker");
    assert.equal(graph.nodes.find((node) => node.label === "Holder")?.field_types?.Bgp, "sp.Speaker");
    const calls = graph.links.filter((link) => link.source === run.id && link.relation === "calls");
    assert.equal(calls.filter((link) => link.target === speakerMethod.id).length, 6);
    assert.equal(calls.filter((link) => link.target === otherMethod.id).length, 1);
    assert.equal(calls.filter((link) => methods.some((method) => method.id === link.target)).length, 7,
      "an untyped interface receiver is not bound to the first same-named method");
    assert.ok(calls.some((link) => link.target === symbols("speaker/speaker.go", "NewSpeaker")[0].id),
      "package-qualified functions still resolve while method names use the receiver index");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("internal-builder: deeply-nested JS does not hang (bounded isExportedDecl, not O(depth^3))", async () => {
  // ~700 nested functions — the exact O(depth^3) .parent-walk trigger; the unbounded version took minutes.
  let body = "return 1;";
  for (let i = 700; i > 0; i--) body = "const f" + i + " = () => { function g" + i + "(){ " + body + " } return g" + i + "; };";
  const dir = repoWith({ "src/deep.js": "function root(){ " + body + " }\n", "src/ok.js": "export function hi(){ return 0; }\n" });
  try {
    const t0 = Date.now();
    const g = await buildInternalGraph(dir);
    const ms = Date.now() - t0;
    assert.ok(g.nodes.length > 0, "build produced nodes");
    assert.equal(g.nodes.find((n) => String(n.id).includes("#hi@")).exported, true, "sibling export still detected");
    assert.ok(ms < 15000, `deep-nesting build finished quickly (${ms}ms) — no O(depth^3) hang`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
