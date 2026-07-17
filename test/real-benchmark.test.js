import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baselineFromReport, runRealRepositoryBenchmark } from '../benchmark/real-runner.mjs'

const graph = {
    edgeProvenanceV: 1,
    nodes: [
        {id: 'src/sample.ts', source_file: 'src/sample.ts'},
        {id: 'src/dep.ts', source_file: 'src/dep.ts'},
        {id: 'src/sample.ts#run@1', source_file: 'src/sample.ts', symbol_kind: 'function'},
    ],
    links: [
        {source: 'src/sample.ts', target: 'src/dep.ts', relation: 'imports', provenance: 'RESOLVED'},
        {source: 'src/sample.ts#run@1', target: 'src/dep.ts', relation: 'imports', provenance: 'RESOLVED'},
    ],
}

function fixture({before = 2, explanation = null} = {}) {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-real-benchmark-'))
    const repo = join(parent, 'repo')
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'src', 'sample.ts'), 'export function run() {}\n')
    writeFileSync(join(repo, 'src', 'dep.ts'), 'export const value = 1\n')
    const manifestPath = join(parent, 'manifest.json')
    const baselinePath = join(parent, 'baseline.json')
    writeFileSync(manifestPath, JSON.stringify({
        schemaVersion: 'weavatrix.real-repositories.v1', baselineVersion: '0.2.1',
        repositories: [
            {id: 'sample', language: 'TypeScript', environment: 'UNSET_BENCHMARK_PATH', candidates: [repo], extensions: ['.ts'],
                ...(explanation ? {allowedRelationRegressions: {imports: explanation}} : {})},
            {id: 'missing', language: 'Rust', environment: 'UNSET_MISSING_PATH', candidates: [], extensions: ['.rs']},
        ],
    }))
    writeFileSync(baselinePath, JSON.stringify({
        schemaVersion: 'weavatrix.real-baseline.v1', builderVersion: '0.2.1',
        repositories: {sample: {metrics: {relations: {imports: before}}}},
    }))
    return {parent, repo, manifestPath, baselinePath}
}

test('real benchmark: reports source-free PASS plus explicit missing repository', async () => {
    const fx = fixture()
    try {
        const report = await runRealRepositoryBenchmark({
            manifestPath: fx.manifestPath, baselinePath: fx.baselinePath, builder: async () => graph,
        })
        assert.equal(report.status, 'PARTIAL')
        assert.equal(report.repositories[0].status, 'PASS')
        assert.equal(report.repositories[1].status, 'MISSING')
        assert.deepEqual(report.gaps.rust, [{code: 'SOURCE_CHECKOUT_MISSING', environment: 'UNSET_MISSING_PATH'}])
        assert.deepEqual(report.counts, {MISSING: 1, PASS: 1})
        assert.ok(report.reportBytes < 64 * 1024)
        const baseline = baselineFromReport(report)
        assert.doesNotMatch(JSON.stringify(baseline), new RegExp(fx.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    } finally { rmSync(fx.parent, {recursive: true, force: true}) }
})

test('real benchmark: unexplained relation drops fail while an explicit explanation is visible', async () => {
    for (const [explanation, expected] of [[null, 'FAIL'], ['resolver model changed intentionally', 'PASS']]) {
        const fx = fixture({before: 3, explanation})
        try {
            const report = await runRealRepositoryBenchmark({
                manifestPath: fx.manifestPath, baselinePath: fx.baselinePath, builder: async () => graph,
            })
            const sample = report.repositories[0]
            assert.equal(sample.status, expected)
            assert.equal(sample.comparison.regressions[0].dropPercent, 33.33)
            assert.equal(sample.comparison.regressions[0].explanation, explanation)
        } finally { rmSync(fx.parent, {recursive: true, force: true}) }
    }
})
