import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  tGetArchitectureContract,
  tPrepareChange,
  tVerifyArchitecture,
} from '../src/mcp/tools-architecture.mjs'

const graphFixture = () => ({
  nodes: [
    {id: 'src/auth/service.ts', source_file: 'src/auth/service.ts'},
    {id: 'src/auth/service.test.ts', source_file: 'src/auth/service.test.ts'},
    {id: 'src/http/client.ts', source_file: 'src/http/client.ts'},
  ],
  links: [],
})

function withEmptyRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'weavatrix-architecture-tools-'))
  try { return run({repoRoot, graphPath: null}) }
  finally { rmSync(repoRoot, {recursive: true, force: true}) }
}

test('only architecture lookup exposes the full starter contract when unconfigured', () => withEmptyRepo((ctx) => {
  const graph = graphFixture()
  const lookup = tGetArchitectureContract(graph, {}, ctx)
  const verify = tVerifyArchitecture(graph, {}, ctx)

  assert.equal(lookup.result.state, 'NOT_CONFIGURED')
  assert.ok(lookup.result.starterContract)
  assert.equal(lookup.result.starterSummary.components, 2)
  assert.deepEqual(lookup.result.starterContract.budgets, {maxFileLoc: 300, runtimeCycles: 0})
  assert.equal(lookup.result.starterSummary.candidateBudgetsNotEnforced > 0, true)
  assert.equal(verify.result.state, 'NOT_CONFIGURED')
  assert.equal('starterContract' in verify.result, false)
  assert.ok(JSON.stringify(verify.result).length < 600)
}))

test('architecture starter proposes non-overlapping product-code territories', () => withEmptyRepo((ctx) => {
  const lookup = tGetArchitectureContract({
    nodes: [
      {id: 'src/index.js', source_file: 'src/index.js'},
      {id: 'src/analysis/a.js', source_file: 'src/analysis/a.js'},
      {id: 'site/index.html', source_file: 'site/index.html'},
      {id: 'worker.ts', source_file: 'worker.ts'},
      {id: 'test/architecture.test.js', source_file: 'test/architecture.test.js'},
      {id: 'docs/example.js', source_file: 'docs/example.js'},
      {id: 'benchmark/fixture.js', source_file: 'benchmark/fixture.js'},
      {id: 'generated/client.ts', source_file: 'generated/client.ts'},
      {id: 'package.json', source_file: 'package.json'},
      {id: 'README.md', source_file: 'README.md'},
    ],
    links: [],
  }, {}, ctx)

  const components = lookup.result.starterContract.components
  assert.deepEqual(components.map((component) => component.id).sort(), ['root-code', 'site', 'src-analysis', 'src-root'])
  assert.deepEqual(components.find((component) => component.id === 'src-root').paths, ['src/index.js'])
  assert.equal(components.some((component) => component.paths.includes('src')), false)
  assert.equal(components.some((component) => component.paths.some((path) => /^(?:test|docs|benchmark|generated)(?:\/|$)/.test(path))), false)
  assert.match(lookup.text, /product-code territories/i)
}))

test('architecture starter adapts Maven package trees and keeps observed directions non-enforcing', () => withEmptyRepo((ctx) => {
  const files = [
    'application/src/main/java/com/edgehawk/warroom/application/handlers/AlertHandler.java',
    'application/src/main/java/com/edgehawk/warroom/application/services/AttackService.java',
    'application/src/main/java/com/edgehawk/warroom/model/DocumentAttack.java',
    'application/src/main/java/com/edgehawk/warroom/controller/AttackController.java',
  ]
  const graph = {
    nodes: files.map((file) => ({id: file, source_file: file})),
    links: [{source: files[0], target: files[2], relation: 'imports'}],
  }
  const result = tGetArchitectureContract(graph, {}, ctx).result
  const paths = result.starterContract.components.flatMap((component) => component.paths)

  assert.deepEqual(paths.sort(), [
    'application/src/main/java/com/edgehawk/warroom/application',
    'application/src/main/java/com/edgehawk/warroom/controller',
    'application/src/main/java/com/edgehawk/warroom/model',
  ])
  assert.deepEqual(result.starterContract.dependencyRules, [])
  assert.equal(result.observedDependencyProposals.length, 1)
  assert.equal(result.observedDependencyProposals[0].state, 'OBSERVED_NOT_ENFORCED')
  assert.equal(result.observedDependencyProposals[0].suggestedRule.action, 'allow')
  assert.equal(result.budgetProposals.every((item) => item.state === 'CANDIDATE_NOT_ENFORCED'), true)
}))

test('architecture starter recursively splits oversized Java territories only at real child packages', () => withEmptyRepo((ctx) => {
  const root = 'application/src/main/java/com/edgehawk/warroom'
  const application = [
    ...Array.from({length: 45}, (_, index) => `${root}/application/handlers/Handler${index}.java`),
    ...Array.from({length: 45}, (_, index) => `${root}/application/repositories/Repository${index}.java`),
  ]
  const flatModel = Array.from({length: 85}, (_, index) => `${root}/model/Document${index}.java`)
  const result = tGetArchitectureContract({
    nodes: [...application, ...flatModel].map((file) => ({id: file, source_file: file})), links: [],
  }, {}, ctx).result
  const paths = result.starterContract.components.flatMap((component) => component.paths)

  assert.ok(paths.includes(`${root}/application/handlers`))
  assert.ok(paths.includes(`${root}/application/repositories`))
  assert.ok(paths.includes(`${root}/model`), 'a flat oversized package stays one honest hotspot')
  assert.equal(paths.includes(`${root}/application`), false)
}))

test('architecture starter recognizes nested source roots and preserves existing Go territories', () => withEmptyRepo((ctx) => {
  const nested = [
    'apps/api/src/controllers/users.ts', 'apps/api/src/services/users.ts',
    'packages/shared/src/model/user.ts', 'packages/shared/src/index.ts',
  ]
  const nestedResult = tGetArchitectureContract({
    nodes: nested.map((file) => ({id: file, source_file: file})), links: [],
  }, {}, ctx).result.starterContract.components.flatMap((component) => component.paths)
  assert.deepEqual(nestedResult.sort(), [
    'apps/api/src/controllers', 'apps/api/src/services',
    'packages/shared/src/index.ts', 'packages/shared/src/model',
  ])

  const go = ['cmd/server/main.go', 'config/env.go', 'controller/http.go', 'model/user.go', 'service/user.go', 'storage/db.go']
  const goComponents = tGetArchitectureContract({
    nodes: go.map((file) => ({id: file, source_file: file})), links: [],
  }, {}, ctx).result.starterContract.components
  assert.equal(goComponents.length, 6)
  assert.deepEqual(goComponents.map((component) => component.id).sort(), ['cmd', 'config', 'controller', 'model', 'service', 'storage'])
}))

test('unconfigured prepare_change returns bounded provisional budgets and test-only classification', () => withEmptyRepo((ctx) => {
  const prepared = tPrepareChange(graphFixture(), {
    intent: 'adjust auth behavior',
    files: ['src/auth/service.ts', 'src/auth/service.test.ts'],
  }, ctx)

  assert.equal(prepared.result.state, 'NOT_CONFIGURED')
  assert.equal(prepared.result.guidance, 'PROVISIONAL_BUDGETS')
  assert.equal(prepared.result.enforceable, false)
  assert.deepEqual(prepared.result.productFiles, ['src/auth/service.ts'])
  assert.deepEqual(prepared.result.testOnlyFiles, ['src/auth/service.test.ts'])
  assert.equal(prepared.result.provisionalBudgets.maxFileLoc, 300)
  assert.equal('starterContract' in prepared.result, false)
  assert.match(prepared.text, /not enforced policy/i)
  assert.ok(JSON.stringify(prepared.result).length < 1_500)
}))

const candidateContract = () => ({
  name: 'Candidate layered target', style: 'layered', enforcement: 'ratchet',
  components: [{id: 'domain', paths: ['src/domain']}, {id: 'ui', paths: ['src/ui']}],
  dependencyRules: [{id: 'domain-no-ui', action: 'forbid', kinds: ['runtime'], from: ['domain'], to: ['ui']}],
  budgets: {}, technologies: {required: [], forbidden: []}, exceptions: [],
  ratchet: {baseline: {fingerprints: [], metrics: {}}},
})

const bootstrapGraph = () => ({
  nodes: [
    {id: 'src/domain/model.ts', source_file: 'src/domain/model.ts'},
    {id: 'src/ui/view.ts', source_file: 'src/ui/view.ts'},
  ],
  links: [{source: 'src/domain/model.ts', target: 'src/ui/view.ts', relation: 'imports'}],
})

test('architecture bootstrap previews exact baseline materialization and writes only after approval', () => withEmptyRepo((ctx) => {
  const target = join(ctx.repoRoot, '.weavatrix', 'architecture.json')
  const preview = tGetArchitectureContract(bootstrapGraph(), {
    action: 'preview', candidate_contract: candidateContract(), baseline_mode: 'accept-current',
  }, ctx)
  assert.equal(preview.result.state, 'PREVIEW')
  assert.equal(preview.result.wrote, false)
  assert.equal(preview.result.candidateVerification.new.length, 1)
  assert.equal(preview.result.materializedVerification.existing.length, 1)
  assert.equal(preview.result.materializedVerification.status, 'PASS')
  assert.equal(preview.result.observedDependencyProposals.length, 1)
  assert.equal(preview.result.observedDependencyProposals[0].state, 'OBSERVED_NOT_ENFORCED')
  assert.equal(existsSync(target), false)
  assert.equal(preview.result.patch.contents.endsWith('\n'), true)

  const approved = tGetArchitectureContract(bootstrapGraph(), {
    action: 'approve', confirm_token: preview.result.confirmToken,
  }, ctx)
  assert.equal(approved.result.state, 'APPROVED')
  assert.equal(approved.result.wrote, true)
  assert.equal(existsSync(target), true)
  const written = JSON.parse(readFileSync(target, 'utf8'))
  assert.deepEqual(written.ratchet.baseline.fingerprints, preview.result.materializedContract.ratchet.baseline.fingerprints)

  const replay = tGetArchitectureContract(bootstrapGraph(), {
    action: 'approve', confirm_token: preview.result.confirmToken,
  }, ctx)
  assert.equal(replay.result.state, 'CONFIRMATION_REQUIRED')
}))

test('architecture bootstrap rejects missing confirmation and graph drift without policy mutation', () => withEmptyRepo((ctx) => {
  const target = join(ctx.repoRoot, '.weavatrix', 'architecture.json')
  const missing = tGetArchitectureContract(bootstrapGraph(), {action: 'approve'}, ctx)
  assert.equal(missing.result.state, 'CONFIRMATION_REQUIRED')
  assert.equal(existsSync(target), false)

  const preview = tGetArchitectureContract(bootstrapGraph(), {
    action: 'preview', candidate_contract: candidateContract(), baseline_mode: 'none',
  }, ctx)
  const changed = bootstrapGraph()
  changed.links = []
  const rejected = tGetArchitectureContract(changed, {
    action: 'approve', confirm_token: preview.result.confirmToken,
  }, ctx)
  assert.equal(rejected.result.state, 'GRAPH_CHANGED')
  assert.equal(rejected.result.wrote, false)
  assert.equal(existsSync(target), false)
}))
