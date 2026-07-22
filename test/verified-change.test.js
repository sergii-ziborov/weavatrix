import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadGraph} from '../src/mcp/graph-context.mjs'
import {expandTaskQuery, retrieveTaskContext} from '../src/analysis/task-retrieval.js'
import {extractCallArgumentEvidence} from '../src/analysis/data-flow-evidence.js'
import {runAllowedTests, validateTestRequests} from '../src/analysis/allowed-test-runner.js'
import {tVerifiedChange} from '../src/mcp/tools-verified-change.mjs'
import {toolResult} from '../src/mcp/tool-result.mjs'

const root = mkdtempSync(join(tmpdir(), 'weavatrix-verified-change-'))
test.after(() => rmSync(root, {recursive: true, force: true}))
mkdirSync(join(root, 'src'), {recursive: true})
writeFileSync(join(root, 'package.json'), JSON.stringify({scripts: {test: 'node --test', lint: 'eslint .', 'verify:unit': 'node -e "process.exit(0)"'}}))
writeFileSync(join(root, 'src', 'caller.js'), "import {target} from './target.js'\nexport function caller(input) { return target(input + 1, 'fixed') }\n")
writeFileSync(join(root, 'src', 'target.js'), 'export function target(value, mode) { return value + mode.length }\n')

const graphPath = join(root, 'graph.json')
const raw = {
  graphBuildMode: 'full', nodes: [
    {id: 'src/caller.js', label: 'caller.js', source_file: 'src/caller.js'},
    {id: 'src/caller.js#caller@2', label: 'caller()', source_file: 'src/caller.js', source_location: 'L2-L2', symbol_kind: 'function'},
    {id: 'src/target.js', label: 'target.js', source_file: 'src/target.js'},
    {id: 'src/target.js#target@1', label: 'target()', source_file: 'src/target.js', source_location: 'L1-L1', symbol_kind: 'function'},
  ], links: [
    {source: 'src/caller.js', target: 'src/caller.js#caller@2', relation: 'contains'},
    {source: 'src/target.js', target: 'src/target.js#target@1', relation: 'contains'},
    {source: 'src/caller.js#caller@2', target: 'src/target.js#target@1', relation: 'calls', line: 2},
  ],
}
writeFileSync(graphPath, JSON.stringify(raw))
const graph = loadGraph(graphPath, {repoRoot: root})

test('hybrid task retrieval prioritizes exact changed symbols over fuzzy task seeds', () => {
  assert.match(expandTaskQuery('проверь авторизацию и роут API'), /authentication/)
  assert.match(expandTaskQuery('проверь авторизацию и роут API'), /router/)
  const result = retrieveTaskContext(graph, {
    task: 'change target value handling', semanticSeeds: [raw.nodes[1]],
    changedSeedIds: ['src/target.js#target@1'], maxSymbols: 2,
  })
  assert.equal(result.status, 'COMPLETE')
  assert.equal(result.selected[0].id, 'src/target.js#target@1')
  assert.ok(result.selected[0].reasons.includes('changed-symbol'))
})

test('hybrid task retrieval suppresses test symbols unless requested or exactly changed', () => {
  const production = {id: 'src/auth/session.js#validateSession@10', label: 'validateSession()', source_file: 'src/auth/session.js', symbol_kind: 'function'}
  const testSymbol = {id: 'test/auth/session.test.js#validatesSession@3', label: 'validatesSession()', source_file: 'test/auth/session.test.js', symbol_kind: 'function'}
  const localGraph = {byId: new Map([[production.id, production], [testSymbol.id, testSymbol]]), out: new Map(), inn: new Map()}

  const focused = retrieveTaskContext(localGraph, {task: 'validate authentication session', semanticSeeds: [production, testSymbol], maxSymbols: 3})
  assert.deepEqual(focused.selected.map((item) => item.id), [production.id])
  assert.equal(focused.suppressedClassified, 1)

  const requested = retrieveTaskContext(localGraph, {task: 'test authentication session', semanticSeeds: [production, testSymbol], maxSymbols: 3})
  assert.ok(requested.selected.some((item) => item.id === testSymbol.id))

  const changed = retrieveTaskContext(localGraph, {task: 'validate authentication session', semanticSeeds: [production], changedSeedIds: [testSymbol.id], maxSymbols: 3})
  assert.equal(changed.selected[0].id, testSymbol.id)
})

test('hybrid task retrieval suppresses node-level test surfaces in production files', () => {
  const production = {id: 'src/config.rs#parse_config@4', label: 'parse_config()', source_file: 'src/config.rs', symbol_kind: 'function'}
  const inlineTest = {id: 'src/config.rs#config_parsing_works@40', label: 'config_parsing_works()', source_file: 'src/config.rs', symbol_kind: 'function', test_surface: true}
  const localGraph = {byId: new Map([[production.id, production], [inlineTest.id, inlineTest]]), out: new Map(), inn: new Map()}

  const focused = retrieveTaskContext(localGraph, {task: 'improve config parsing validation', semanticSeeds: [production, inlineTest], maxSymbols: 3})
  assert.deepEqual(focused.selected.map((item) => item.id), [production.id], 'a Rust #[cfg(test)] symbol in a production .rs file never anchors a production change task')
  assert.equal(focused.suppressedClassified, 1)

  const requested = retrieveTaskContext(localGraph, {task: 'improve the config parsing unit test', semanticSeeds: [production, inlineTest], maxSymbols: 3})
  assert.ok(requested.selected.some((item) => item.id === inlineTest.id), 'a test-term task opts inline test symbols back in')
})

test('bounded interprocedural evidence maps call arguments to callee parameters', () => {
  const result = extractCallArgumentEvidence({graph, repoRoot: root, seedIds: ['src/caller.js#caller@2'], depth: 2, maxEdges: 10})
  assert.equal(result.status, 'COMPLETE')
  assert.equal(result.edges.length, 1)
  assert.deepEqual(result.edges[0].arguments, [
    {index: 0, expression: 'input + 1', parameter: 'value'},
    {index: 1, expression: "'fixed'", parameter: 'mode'},
  ])
  assert.match(result.model, /not CFG or taint/i)
  const inbound = extractCallArgumentEvidence({graph, repoRoot: root, seedIds: ['src/target.js#target@1'], depth: 1, maxEdges: 10})
  assert.equal(inbound.edges[0].from, 'src/caller.js#caller@2')
  assert.equal(inbound.edges[0].arguments[0].parameter, 'value')
})

test('targeted test runner rejects arbitrary package scripts and stays disabled by default', async () => {
  const original = process.env.WEAVATRIX_ALLOW_TEST_RUNS
  delete process.env.WEAVATRIX_ALLOW_TEST_RUNS
  assert.equal(validateTestRequests(root, [{script: 'lint'}]).ok, false)
  assert.equal(validateTestRequests(root, [{script: 'verify:unit'}]).ok, true)
  assert.equal(validateTestRequests(root, [{script: 'test', args: ['x & whoami']}]).ok, false)
  const result = await runAllowedTests(root, [{script: 'test'}], {enabled: true})
  assert.equal(result.state, 'DISABLED')
  assert.match(result.reason, /WEAVATRIX_ALLOW_TEST_RUNS=1/)
  process.env.WEAVATRIX_ALLOW_TEST_RUNS = '1'
  try {
    const executed = await runAllowedTests(root, [{script: 'verify:unit'}], {enabled: true, timeoutMs: 30_000})
    assert.equal(executed.state, 'PASS')
    assert.equal(executed.results[0].exitCode, 0)
  } finally {
    if (original == null) delete process.env.WEAVATRIX_ALLOW_TEST_RUNS
    else process.env.WEAVATRIX_ALLOW_TEST_RUNS = original
  }
})

test('test evidence does not require package.json when nothing can run', async (t) => {
  const pythonRoot = mkdtempSync(join(tmpdir(), 'weavatrix-verified-change-python-'))
  t.after(() => rmSync(pythonRoot, {recursive: true, force: true}))
  writeFileSync(join(pythonRoot, 'app.py'), 'def greet(name):\n    return f"Hello {name}"\n')

  assert.deepEqual(validateTestRequests(pythonRoot, []), {ok: true, tests: []})
  const notRequested = await runAllowedTests(pythonRoot, [], {enabled: false})
  assert.equal(notRequested.state, 'NOT_REQUESTED')
  assert.doesNotMatch(notRequested.reason, /package\.json/i)

  const disabled = await runAllowedTests(pythonRoot, [{script: 'test'}], {enabled: false})
  assert.equal(disabled.state, 'DISABLED')
  assert.deepEqual(disabled.plan, [{script: 'test', args: []}])
  assert.doesNotMatch(disabled.reason, /package\.json/i)
})

test('verified_change plan and verify keep Python-only repositories out of package-script blockers', async (t) => {
  const pythonRoot = mkdtempSync(join(tmpdir(), 'weavatrix-verified-change-python-repo-'))
  t.after(() => rmSync(pythonRoot, {recursive: true, force: true}))
  writeFileSync(join(pythonRoot, 'app.py'), 'def greet(name):\n    return f"Hello {name}"\n')
  const pythonGraphPath = join(pythonRoot, 'graph.json')
  writeFileSync(pythonGraphPath, JSON.stringify({
    graphBuildMode: 'full',
    nodes: [
      {id: 'app.py', label: 'app.py', source_file: 'app.py'},
      {id: 'app.py#greet@1', label: 'greet()', source_file: 'app.py', source_location: 'L1-L2', symbol_kind: 'function'},
    ],
    links: [{source: 'app.py', target: 'app.py#greet@1', relation: 'contains'}],
  }))
  const pythonGraph = loadGraph(pythonGraphPath, {repoRoot: pythonRoot})
  const pythonTools = {
    impact: async () => toolResult('impact', {
      status: 'COMPLETE', verdict: 'LOW', changes: [{path: 'app.py'}],
      seeds: {ids: ['app.py#greet@1'], unmappedIds: []}, blastRadius: {impacted: 0, nodes: []},
    }),
    context: async () => null,
    inspect: async () => null,
    prepareChange: () => toolResult('architecture', {state: 'READY'}),
    verifyArchitecture: () => toolResult('architecture', {state: 'PASS', verification: {status: 'PASS', new: []}}),
    traceApi: async () => null,
  }
  const context = {repoRoot: pythonRoot, graphPath: pythonGraphPath}
  const permissions = {source: false, health: false, crossrepo: false}

  const plan = await tVerifiedChange(pythonGraph, {
    task: 'change greet behavior', phase: 'plan', files: ['app.py'], run_tests: false,
  }, context, pythonTools, permissions)
  assert.equal(plan.result.tests.state, 'NOT_REQUESTED')
  assert.ok(!plan.result.blockers.some((item) => /package|test/i.test(item)))

  const disabledPlan = await tVerifiedChange(pythonGraph, {
    task: 'change greet behavior', phase: 'plan', files: ['app.py'], tests: [{script: 'test'}], run_tests: false,
  }, context, pythonTools, permissions)
  assert.equal(disabledPlan.result.tests.state, 'DISABLED')
  assert.ok(!disabledPlan.result.blockers.some((item) => /package|test/i.test(item)))

  const verifyNotRequested = await tVerifiedChange(pythonGraph, {
    task: 'change greet behavior', phase: 'verify', files: ['app.py'], run_tests: false,
    duplicate_ratchet: false,
  }, context, pythonTools, permissions)
  assert.equal(verifyNotRequested.result.tests.state, 'NOT_REQUESTED')
  assert.notEqual(verifyNotRequested.result.verdict, 'BLOCKED')
  assert.ok(!verifyNotRequested.result.blockers.some((item) => /package|test/i.test(item)))

  const verify = await tVerifiedChange(pythonGraph, {
    task: 'change greet behavior', phase: 'verify', files: ['app.py'], tests: [{script: 'test'}],
    run_tests: false, duplicate_ratchet: false,
  }, context, pythonTools, permissions)
  assert.equal(verify.result.tests.state, 'DISABLED')
  assert.notEqual(verify.result.verdict, 'BLOCKED')
  assert.ok(!verify.result.blockers.some((item) => /package|test/i.test(item)))
})

test('verified_change plan returns one proof envelope instead of requiring manual orchestration', async () => {
  const tools = {
    impact: async () => toolResult('impact', {
      status: 'COMPLETE', verdict: 'MEDIUM', changes: [{path: 'src/target.js'}],
      seeds: {ids: ['src/target.js#target@1'], unmappedIds: []},
      blastRadius: {impacted: 1, nodes: [{id: 'src/caller.js#caller@2', testEvidence: {staticTestReachability: {status: 'REACHABLE', test: 'test/target.test.js'}}}]},
    }),
    context: async (_g, args) => toolResult('context', {
      status: 'OK', definition: {id: args.label}, evidence: {state: 'EXACT'}, references: {occurrences: 2, files: 1},
      inbound: {total: 1, shown: [{id: 'src/caller.js#caller@2', label: 'caller()', file: 'src/caller.js'}]}, outbound: {total: 0}, reExports: {total: 0}, source: [],
    }),
    inspect: async () => null,
    prepareChange: () => toolResult('architecture', {state: 'READY'}),
    verifyArchitecture: () => toolResult('architecture', {state: 'PASS', verification: {status: 'PASS', new: []}}),
    traceApi: async () => null,
  }
  const result = await tVerifiedChange(graph, {
    task: 'change target value handling', phase: 'plan', base_ref: 'HEAD', duplicate_ratchet: true,
  }, {repoRoot: root, graphPath}, tools, {source: true, health: true, crossrepo: false})
  assert.equal(result.result.schemaVersion, 'weavatrix.verified-change.v1')
  assert.equal(result.result.verdict, 'UNKNOWN')
  assert.equal(result.result.retrieval.selected[0].id, 'src/target.js#target@1')
  assert.equal(result.result.editContexts[0].evidence.state, 'EXACT')
  assert.deepEqual(result.result.tests.suggestedFiles, ['test/target.test.js'])
  assert.deepEqual(result.result.duplicates, {
    state: 'PLANNED', enabled: true, reason: 'duplicate ratchet runs during verify phase',
  })
  assert.match(result.text, /^UNKNOWN — verified_change plan/)
  assert.match(result.text, /duplicates PLANNED/)
  assert.doesNotMatch(result.text, /duplicate ratchet disabled/)
  assert.match(result.text, /Exact usage: target\(\) — 2 reference occurrence\(s\) in 1 file\(s\); 1 inbound container\(s\): caller\(\) \[src\/caller\.js\]\./)
})
