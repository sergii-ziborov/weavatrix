import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {computeDeleteReadiness} from '../src/analysis/delete-readiness.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-delete-'))
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repoRoot, path, '..'), {recursive: true})
        writeFileSync(join(repoRoot, path), content)
    }
    return repoRoot
}

const helperNode = (overrides = {}) => ({
    id: 'src/util.ts#helper@2',
    label: 'helper',
    source_file: 'src/util.ts',
    exported: false,
    selection_start: {line: 1, character: 9},
    selection_end: {line: 1, character: 15},
    source_range: {start: {line: 1, character: 0}, end: {line: 3, character: 1}},
    ...overrides,
})

const HELPER_SOURCE = 'const keep = 1\nfunction helper() {\n    return helper\n}\nexport {keep}\n'

const zeroConfirmed = async () => ({overlay: {state: 'COMPLETE', locations: [], noReferenceSymbols: ['src/util.ts#helper@2']}})
const incomplete = async () => ({overlay: {state: 'PARTIAL', locations: [], noReferenceSymbols: []}})

test('safe:true requires the exact zero proof AND no risk signals', async () => {
    const repoRoot = fixtureRepo({'src/util.ts': HELPER_SOURCE})
    const result = await computeDeleteReadiness({
        repoRoot,
        rawGraph: {nodes: [helperNode()], links: []},
        graphPath: join(repoRoot, 'graph.json'),
        targetId: 'src/util.ts#helper@2',
        queryPrecision: zeroConfirmed,
    })
    assert.equal(result.status, 'OK')
    assert.equal(result.safe, true)
    assert.equal(result.confidence, 'high')
    assert.equal(result.knownReferences.length, 0)
    assert.equal(result.deletion.startLine, 2)
    assert.equal(result.deletion.endLine, 4)
    assert.equal(result.autoDelete, false)
    assert.equal(result.decision, 'REVIEW_REQUIRED')
})

test('without the exact proof the verdict is UNPROVEN, never a false clean', async () => {
    const repoRoot = fixtureRepo({'src/util.ts': HELPER_SOURCE})
    const result = await computeDeleteReadiness({
        repoRoot,
        rawGraph: {nodes: [helperNode()], links: []},
        graphPath: join(repoRoot, 'graph.json'),
        targetId: 'src/util.ts#helper@2',
        queryPrecision: incomplete,
    })
    assert.equal(result.safe, 'UNPROVEN')
    assert.equal(result.confidence, 'medium')
    assert.match(result.reason, /never proof/)
})

test('an exported symbol is permanently capped at UNPROVEN even with the zero proof', async () => {
    const repoRoot = fixtureRepo({'src/util.ts': HELPER_SOURCE})
    const result = await computeDeleteReadiness({
        repoRoot,
        rawGraph: {nodes: [helperNode({exported: true})], links: []},
        graphPath: join(repoRoot, 'graph.json'),
        targetId: 'src/util.ts#helper@2',
        queryPrecision: zeroConfirmed,
    })
    assert.equal(result.safe, 'UNPROVEN')
    assert.equal(result.confidence, 'low')
    const external = result.unknownDynamicUsages.find((usage) => usage.signal === 'EXTERNAL_CONSUMERS')
    assert.equal(external.status, 'NOT_POSSIBLE_FROM_REPOSITORY_GRAPH')
})

test('known graph references force safe:false with the reference list', async () => {
    const repoRoot = fixtureRepo({'src/util.ts': HELPER_SOURCE, 'src/app.ts': "import {helper} from './util'\n"})
    const rawGraph = {
        nodes: [helperNode(), {id: 'src/app.ts#main@1', label: 'main', source_file: 'src/app.ts'}],
        links: [{source: 'src/app.ts#main@1', target: 'src/util.ts#helper@2', type: 'calls', confidence: 'RESOLVED'}],
    }
    const result = await computeDeleteReadiness({repoRoot, rawGraph, targetId: 'src/util.ts#helper@2', queryPrecision: zeroConfirmed})
    assert.equal(result.safe, false)
    assert.equal(result.confidence, 'high')
    assert.equal(result.knownReferences[0].kind, 'GRAPH_EDGE')
    assert.equal(result.knownReferences[0].path, 'src/app.ts')
})

test('structural containment edges never count as references', async () => {
    const repoRoot = fixtureRepo({'src/util.ts': HELPER_SOURCE})
    const rawGraph = {
        nodes: [helperNode(), {id: 'src/util.ts', label: 'util.ts', source_file: 'src/util.ts'}],
        links: [{source: 'src/util.ts', target: 'src/util.ts#helper@2', type: 'contains'}],
    }
    const result = await computeDeleteReadiness({repoRoot, rawGraph, graphPath: join(repoRoot, 'g.json'), targetId: 'src/util.ts#helper@2', queryPrecision: zeroConfirmed})
    assert.equal(result.safe, true)
})

test('a same-file occurrence outside the deletion range blocks; inside the body it does not', async () => {
    const withOutsideUse = 'function helper() {\n    return 1\n}\nconst x = helper()\n'
    const repoRoot = fixtureRepo({'src/util.ts': withOutsideUse})
    const node = helperNode({
        selection_start: {line: 0, character: 9},
        selection_end: {line: 0, character: 15},
        source_range: {start: {line: 0, character: 0}, end: {line: 2, character: 1}},
        id: 'src/util.ts#helper@1',
    })
    const result = await computeDeleteReadiness({
        repoRoot,
        rawGraph: {nodes: [node], links: []},
        graphPath: join(repoRoot, 'g.json'),
        targetId: 'src/util.ts#helper@1',
        queryPrecision: zeroConfirmed,
    })
    assert.equal(result.safe, false)
    assert.equal(result.knownReferences[0].kind, 'LEXICAL_SAME_FILE')
    assert.equal(result.knownReferences[0].line, 4)
})

test('dynamic-code and reflection signals in the declaring file cap the verdict', async () => {
    const dynamicSource = 'function helper() {\n    return 1\n}\nconst mod = require(someName)\n'
    const repoRoot = fixtureRepo({'src/util.ts': dynamicSource})
    const node = helperNode({
        selection_start: {line: 0, character: 9},
        selection_end: {line: 0, character: 15},
        source_range: {start: {line: 0, character: 0}, end: {line: 2, character: 1}},
        id: 'src/util.ts#helper@1',
    })
    const result = await computeDeleteReadiness({
        repoRoot,
        rawGraph: {nodes: [node], links: []},
        graphPath: join(repoRoot, 'g.json'),
        targetId: 'src/util.ts#helper@1',
        queryPrecision: zeroConfirmed,
    })
    assert.equal(result.safe, 'UNPROVEN')
    assert.equal(result.confidence, 'low')
    const dynamic = result.unknownDynamicUsages.find((usage) => usage.signal === 'DYNAMIC_LOADING')
    assert.equal(dynamic.status, 'PRESENT')
})

test('non-JS/TS symbols report the language limit and stay UNPROVEN', async () => {
    const repoRoot = fixtureRepo({'main.py': 'def helper():\n    pass\n'})
    const node = {
        id: 'main.py#helper@1',
        label: 'helper',
        source_file: 'main.py',
        source_range: {start: {line: 0, character: 0}, end: {line: 1, character: 8}},
    }
    const result = await computeDeleteReadiness({repoRoot, rawGraph: {nodes: [node], links: []}, graphPath: join(repoRoot, 'g.json'), targetId: 'main.py#helper@1'})
    assert.equal(result.safe, 'UNPROVEN')
    const exact = result.unknownDynamicUsages.find((usage) => usage.signal === 'EXACT_LSP_REFERENCES')
    assert.equal(exact.status, 'NOT_SUPPORTED_FOR_LANGUAGE')
})

test('unknown symbols and unreadable sources fail closed with explicit statuses', async () => {
    const repoRoot = fixtureRepo({'src/util.ts': HELPER_SOURCE})
    const rawGraph = {nodes: [helperNode()], links: []}
    assert.equal((await computeDeleteReadiness({repoRoot, rawGraph, targetId: 'nope#x@1'})).status, 'NOT_FOUND')
    const gone = await computeDeleteReadiness({repoRoot, rawGraph: {nodes: [helperNode({source_file: 'src/missing.ts', id: 'src/missing.ts#helper@2'})], links: []}, targetId: 'src/missing.ts#helper@2'})
    assert.equal(gone.status, 'SOURCE_UNAVAILABLE')
})
