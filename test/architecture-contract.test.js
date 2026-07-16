import test from 'node:test'
import assert from 'node:assert/strict'
import {contractForChange, normalizeArchitectureContract, verifyArchitecture} from '../src/analysis/architecture-contract.js'

const contractFixture = (extra = {}) => normalizeArchitectureContract({
  name: 'Layered target',
  style: 'clean',
  enforcement: 'ratchet',
  components: [
    {id: 'ui', paths: ['src/ui']},
    {id: 'domain', paths: ['src/domain']},
    {id: 'infra', paths: ['src/infra']},
  ],
  dependencyRules: [
    {id: 'domain-no-ui', action: 'forbid', from: ['domain'], to: ['ui'], kinds: ['runtime']},
  ],
  budgets: {runtimeCycles: 0, maxFunctionLoc: 100, maxCyclomatic: 10},
  ...extra,
})

const graphFixture = () => ({
  nodes: [
    {id: 'src/domain/model.ts', source_file: 'src/domain/model.ts'},
    {id: 'src/ui/view.ts', source_file: 'src/ui/view.ts'},
    {id: 'src/domain/model.ts#calculate@10', label: 'calculate()', source_file: 'src/domain/model.ts', complexity: {loc: 130, cyclomatic: 4}},
  ],
  links: [
    {source: 'src/domain/model.ts', target: 'src/ui/view.ts', relation: 'imports'},
  ],
})

test('architecture contract normalizes deterministically and selects change rules', () => {
  const contract = contractFixture()
  assert.equal(contract.architectureContractV, 1)
  assert.equal(contract.contractHash.length, 64)
  assert.equal(contractForChange(contract, ['src/domain/model.ts']).components[0], 'domain')
  assert.equal(contractForChange(contract, ['src/domain/model.ts']).rules[0].id, 'domain-no-ui')
})

test('architecture ratchet distinguishes new, existing and fixed violations', () => {
  const first = verifyArchitecture({graph: graphFixture(), contract: contractFixture()})
  assert.equal(first.status, 'FAIL')
  assert.equal(first.new.length, 2, 'dependency and LOC budget are new debt')

  const baseline = first.new.map((item) => item.fingerprint)
  const accepted = verifyArchitecture({
    graph: graphFixture(),
    contract: contractFixture({ratchet: {baseline: {fingerprints: baseline}}}),
  })
  assert.equal(accepted.status, 'PASS')
  assert.equal(accepted.existing.length, 2)

  const cleanGraph = {nodes: graphFixture().nodes.slice(0, 2), links: []}
  const fixed = verifyArchitecture({
    graph: cleanGraph,
    contract: contractFixture({ratchet: {baseline: {fingerprints: baseline}}}),
  })
  assert.equal(fixed.status, 'PASS')
  assert.deepEqual(fixed.fixed.sort(), baseline.sort())
})

test('barrel proxy edges do not create architecture dependency violations', () => {
  const graph = graphFixture()
  graph.links[0].barrelProxy = true
  const result = verifyArchitecture({graph, contract: contractFixture({budgets: {runtimeCycles: 0}})})
  assert.equal(result.new.length, 0)
})

test('architecture fitness budgets enforce component size, cohesion and boundary pressure', () => {
  const graph = {
    nodes: [
      {id: 'src/ui/a.ts', source_file: 'src/ui/a.ts'},
      {id: 'src/ui/b.ts', source_file: 'src/ui/b.ts'},
      {id: 'src/domain/model.ts', source_file: 'src/domain/model.ts'},
    ],
    links: [
      {source: 'src/ui/a.ts', target: 'src/ui/b.ts', relation: 'imports'},
      {source: 'src/ui/a.ts', target: 'src/domain/model.ts', relation: 'imports'},
    ],
  }
  const result = verifyArchitecture({
    graph,
    contract: contractFixture({budgets: {maxModuleFiles: 1, minModuleCohesion: .75, maxModuleBoundaryRatio: .4}}),
  })
  assert.deepEqual(result.new.map((item) => `${item.ruleId}:${item.evidence}`).sort(), [
    'budget.maxModuleBoundaryRatio:domain boundary ratio',
    'budget.maxModuleBoundaryRatio:ui boundary ratio',
    'budget.maxModuleFiles:ui files',
    'budget.minModuleCohesion:domain cohesion',
    'budget.minModuleCohesion:ui cohesion',
  ])
  assert.deepEqual(result.metrics.componentFitness.ui, {files: 2, cohesion: .5, boundaryRatio: .5})
})
