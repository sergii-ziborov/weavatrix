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

test('verified_change plan returns one proof envelope instead of requiring manual orchestration', async () => {
  const tools = {
    impact: async () => toolResult('impact', {
      status: 'COMPLETE', verdict: 'MEDIUM', changes: [{path: 'src/target.js'}],
      seeds: {ids: ['src/target.js#target@1'], unmappedIds: []},
      blastRadius: {impacted: 1, nodes: [{id: 'src/caller.js#caller@2', testEvidence: {staticTestReachability: {status: 'REACHABLE', test: 'test/target.test.js'}}}]},
    }),
    context: async (_g, args) => toolResult('context', {
      status: 'OK', definition: {id: args.label}, evidence: {state: 'EXACT'}, references: {occurrences: 2},
      inbound: {total: 1}, outbound: {total: 0}, reExports: {total: 0}, source: [],
    }),
    inspect: async () => null,
    prepareChange: () => toolResult('architecture', {state: 'READY'}),
    verifyArchitecture: () => toolResult('architecture', {state: 'PASS', verification: {status: 'PASS', new: []}}),
    traceApi: async () => null,
  }
  const result = await tVerifiedChange(graph, {task: 'change target value handling', phase: 'plan', base_ref: 'HEAD'}, {repoRoot: root, graphPath}, tools, {source: true, health: true, crossrepo: false})
  assert.equal(result.result.schemaVersion, 'weavatrix.verified-change.v1')
  assert.equal(result.result.verdict, 'UNKNOWN')
  assert.equal(result.result.retrieval.selected[0].id, 'src/target.js#target@1')
  assert.equal(result.result.editContexts[0].evidence.state, 'EXACT')
  assert.deepEqual(result.result.tests.suggestedFiles, ['test/target.test.js'])
  assert.match(result.text, /^UNKNOWN — verified_change plan/)
})
