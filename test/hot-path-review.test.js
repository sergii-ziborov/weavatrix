import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildInternalGraph} from '../src/graph/internal-builder.js'
import {computeHotPathReview} from '../src/analysis/hot-path-review.js'
import {tHotPathReview} from '../src/mcp/tools-health.mjs'

function fixtureRepo() {
    const root = mkdtempSync(join(tmpdir(), 'weavatrix-hot-path-'))
    mkdirSync(join(root, 'src'), {recursive: true})
    writeFileSync(join(root, 'src', 'work.js'), [
        'export function expensive(groups) {',
        '  const output = []',
        '  for (const rows of groups) {',
        '    const copied = rows.map((row) => ({...row}))',
        '    copied.sort((a, b) => a.id - b.id)',
        '    for (const item of copied) output.push(item)',
        '  }',
        '  return output',
        '}',
        'export function caller(groups) { return expensive(groups) }',
        'export function cheap(value) { return value + 1 }',
    ].join('\n'))
    return root
}

test('hot path review ranks inside-loop allocation, scan and sort evidence separately from graph risk', async () => {
    const root = fixtureRepo()
    try {
        const graph = await buildInternalGraph(root)
        assert.equal(graph.complexityV, 2)
        const expensive = graph.nodes.find((node) => String(node.id).includes('#expensive@'))
        assert.ok(expensive)
        assert.ok(expensive.complexity.allocationsInLoops > 0)
        assert.ok(expensive.complexity.linearOpsInLoops > 0)
        assert.ok(expensive.complexity.sortsInLoops > 0)
        assert.ok(expensive.complexity.hotEvidence.some((item) => item.kind === 'sort-in-loop' && item.line === 5))

        const review = computeHotPathReview(graph, {repoRoot: root, topN: 5})
        assert.equal(review.ok, true)
        assert.equal(review.coverage.actualCoverage, 'NOT_AVAILABLE')
        assert.equal(review.hotspots[0].id, expensive.id)
        assert.ok(review.hotspots[0].localSyntax.score > review.hotspots[0].graphRisk.score)
        assert.ok(review.hotspots[0].graphRisk.fanIn >= 1)
        assert.ok(review.hotspots[0].sourceEvidence.some((item) => item.kind === 'allocation-in-loop'))
        assert.match(review.caveats.join(' '), /not profiler measurements|does not propagate/i)

        mkdirSync(join(root, 'coverage'), {recursive: true})
        const sourcePath = join(root, 'src', 'work.js')
        writeFileSync(join(root, 'coverage', 'coverage-final.json'), JSON.stringify({
            [sourcePath]: {
                path: sourcePath,
                statementMap: {'0': {start: {line: 4}, end: {line: 4}}, '1': {start: {line: 5}, end: {line: 5}}},
                s: {'0': 1, '1': 0},
            },
        }))
        const measured = computeHotPathReview(graph, {repoRoot: root, topN: 5})
        assert.equal(measured.coverage.actualCoverage, 'AVAILABLE')
        assert.equal(measured.hotspots[0].testEvidence.actualCoverage, 0.5)
        assert.equal(measured.hotspots[0].testEvidence.source, 'coverage-final.json')
    } finally {
        rmSync(root, {recursive: true, force: true})
    }
})

test('hot_path_review tool is bounded, structured and rejects traversal scope', async () => {
    const root = fixtureRepo()
    try {
        const graph = await buildInternalGraph(root)
        const graphPath = join(root, 'graph.json')
        writeFileSync(graphPath, JSON.stringify(graph))
        const value = tHotPathReview(null, {top_n: 1}, {repoRoot: root, graphPath})
        assert.equal(value.__weavatrixToolResult, true)
        assert.equal(value.result.bounds.returned, 1)
        assert.equal(value.result.bounds.truncated, value.result.candidateSymbols > 1)
        assert.match(value.text, /Local syntax cost and graph coupling are separate/)
        assert.match(value.text, /actualCoverage: NOT_AVAILABLE/)

        const refused = tHotPathReview(null, {path: '../outside'}, {repoRoot: root, graphPath})
        assert.equal(refused.result.ok, false)
        assert.match(refused.text, /refused.*repository-relative/i)
    } finally {
        rmSync(root, {recursive: true, force: true})
    }
})
