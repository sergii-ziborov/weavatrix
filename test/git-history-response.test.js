import test from 'node:test'
import assert from 'node:assert/strict'
import {Buffer} from 'node:buffer'
import {gitHistoryToolResult} from '../src/mcp/tools-history.mjs'
import {normalizeToolResult} from '../src/mcp/tool-result.mjs'

function fileEntry(index) {
    return {
        file: `src/${String(index).padStart(4, '0')}-${'bounded-path-'.repeat(8)}.js`,
        commits: index + 1,
        additions: index + 2,
        deletions: index + 3,
        binaryChanges: 0,
        churn: (index + 2) * 2,
        connectivity: index + 1,
        churnPercentile: 0.9,
        connectivityPercentile: 0.8,
        hotspotScore: 0.72,
    }
}

function pairEntry(index) {
    return {
        left: `src/left-${String(index).padStart(4, '0')}-${'bounded-'.repeat(8)}.js`,
        right: `src/right-${String(index).padStart(4, '0')}-${'bounded-'.repeat(8)}.js`,
        source: `src/source-${String(index).padStart(4, '0')}.js`,
        test: `test/source-${String(index).padStart(4, '0')}.test.js`,
        count: index + 1,
        jaccard: 0.5,
        lift: 1.5,
        confidence: 0.75,
        leftConfidence: 0.7,
        rightConfidence: 0.75,
        graphDistance: null,
    }
}

test('git_history top_n hard-bounds every structured collection and reports truncation', () => {
    const result = {
        gitHistoryV: 1,
        status: 'complete',
        window: {months: 6, since: '2026-01-01T00:00:00.000Z', until: '2026-07-01T00:00:00.000Z'},
        limits: {maxCommits: 1000, maxPairs: 100, minPairCount: 3},
        completeness: {complete: true, reasons: []},
        totals: {commitsRead: 900, commitsAnalyzed: 900, files: 681, churn: 50000},
        fileChurn: Array.from({length: 681}, (_, index) => fileEntry(index)),
        hotspots: Array.from({length: 464}, (_, index) => fileEntry(index)),
        coupling: {
            eligibleCommits: 900,
            totalCandidates: 5000,
            candidatesTruncated: false,
            observed: Array.from({length: 100}, (_, index) => pairEntry(index)),
            expectedTestSource: Array.from({length: 75}, (_, index) => pairEntry(index)),
            hidden: Array.from({length: 80}, (_, index) => pairEntry(index)),
        },
    }

    const value = gitHistoryToolResult(result, {top_n: 5})
    const collections = {
        fileChurn: value.result.fileChurn,
        hotspots: value.result.hotspots,
        'coupling.observed': value.result.coupling.observed,
        'coupling.expectedTestSource': value.result.coupling.expectedTestSource,
        'coupling.hidden': value.result.coupling.hidden,
    }
    for (const [name, items] of Object.entries(collections)) {
        assert.ok(items.length <= 5, `${name} exceeded top_n`)
        assert.equal(value.page.collections[name].returned, items.length)
        assert.equal(value.page.collections[name].truncated, true)
    }
    assert.equal(value.page.collections.fileChurn.total, 681)
    assert.equal(value.page.collections.hotspots.total, 464)
    assert.equal(value.page.limit, 5)
    assert.equal(value.page.truncated, true)
    assert.equal(value.result.limits.topN, 5)
    assert.equal(result.fileChurn.length, 681, 'response bounding must not mutate the full local analysis')

    const normalized = normalizeToolResult({
        toolName: 'git_history',
        value,
        args: {top_n: 5, output_format: 'json'},
        ctx: {repoRoot: 'C:/work/example'},
        freshness: 'fresh',
    })
    assert.deepEqual(JSON.parse(normalized.text), normalized.structured)
    assert.ok(Buffer.byteLength(normalized.text, 'utf8') < 32 * 1024, 'top_n=5 JSON response must stay below 32 KiB')
    assert.ok(Buffer.byteLength(value.text, 'utf8') < 8 * 1024, 'text summary must stay compact')
})
