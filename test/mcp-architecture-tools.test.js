import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
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
  assert.equal(verify.result.state, 'NOT_CONFIGURED')
  assert.equal('starterContract' in verify.result, false)
  assert.ok(JSON.stringify(verify.result).length < 600)
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
