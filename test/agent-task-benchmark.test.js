import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runAgentTaskBenchmark} from '../scripts/run-agent-task-benchmark.mjs'

test('agent-task benchmark reports local metrics without fabricating competitor results', () => {
  const report = runAgentTaskBenchmark()
  assert.equal(report.weavatrix.status, 'PASS')
  assert.equal(report.weavatrix.metrics.taskSuccessRate, 1)
  assert.equal(report.weavatrix.metrics.falsePositiveRate, 0)
  assert.ok(report.weavatrix.metrics.estimatedOutputTokens > 0)
  assert.equal(report.comparisonStatus, 'INCOMPLETE')
  assert.equal(report.competitors['codebase-memory'].status, 'MISSING')
  assert.equal(report.competitors.serena.status, 'MISSING')
  assert.equal(report.independentComparison.status, 'MISSING')
  assert.match(report.scope, /not an end-to-end/i)
})

test('agent-task benchmark accepts only same-task independent change results for all systems', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weavatrix-agent-results-'))
  try {
    const path = join(dir, 'results.json')
    const runs = (offset) => [
      {taskId: 'change-auth', success: offset < 2, falsePositives: offset, tokens: 1000 + offset, durationMs: 2000 + offset},
      {taskId: 'refactor-router', success: true, falsePositives: 0, tokens: 1200 + offset, durationMs: 2200 + offset},
    ]
    writeFileSync(path, JSON.stringify({
      schemaVersion: 'weavatrix.agent-change-results.v1', evaluator: 'independent-test-fixture',
      systems: {weavatrix: {runs: runs(0)}, 'codebase-memory': {runs: runs(1)}, serena: {runs: runs(2)}},
    }))
    const report = runAgentTaskBenchmark({independentResults: path})
    assert.equal(report.comparisonStatus, 'COMPLETE')
    assert.equal(report.independentComparison.metrics.weavatrix.changeSuccessRate, 1)
    assert.equal(report.independentComparison.metrics.serena.changeSuccessRate, 0.5)
    assert.equal(report.competitors.serena.status, 'COMPLETE')
  } finally { rmSync(dir, {recursive: true, force: true}) }
})
