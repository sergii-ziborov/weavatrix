import test from 'node:test'
import assert from 'node:assert/strict'
import { runGoldenBenchmark } from '../benchmark/runner.mjs'
import { BENCHMARK_BUDGETS, BENCHMARK_SCHEMA, GOLDEN_CASES } from '../benchmark/cases.mjs'

test('golden benchmark: six languages and cross-repository contracts stay correct and bounded', {timeout: 120_000}, async () => {
    const report = await runGoldenBenchmark({includeLifecycle: false})

    assert.equal(report.schemaVersion, BENCHMARK_SCHEMA)
    assert.equal(report.status, 'PASS')
    assert.deepEqual(report.cases.map((item) => item.id), GOLDEN_CASES.map((item) => item.id))
    assert.ok(report.cases.every((item) => item.gates.correctness))
    assert.ok(report.cases.every((item) => item.gates.provenance && item.provenance.complete))
    assert.ok(report.cases.every((item) => item.gates.graphBytes))
    assert.ok(report.cases.every((item) => item.gates.coldLatency))
    assert.equal(report.crossRepo.status, 'PASS')
    assert.equal(report.frameworkConventions.status, 'PASS')
    assert.equal(report.gates.crossRepo, true)
    assert.equal(report.gates.frameworkConventions, true)
    assert.equal(report.gates.totalColdLatency, true)
    assert.equal(report.gates.reportBytes, true)
    assert.ok(report.metrics.reportBytes <= BENCHMARK_BUDGETS.maxReportBytes)
    assert.deepEqual(report.gaps, {java: [], rust: []})
    assert.equal(report.lifecycle, null)
})
