import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildRelatedRenamePlan} from '../src/precision/related-rename-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-related-'))
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repoRoot, path, '..'), {recursive: true})
        writeFileSync(join(repoRoot, path), content)
    }
    return repoRoot
}

const node = (id, label, file, startChar, endChar, line = 0) => ({
    id,
    label,
    source_file: file,
    exported: false,
    selection_start: {line, character: startChar},
    selection_end: {line, character: endChar},
})

const lspEdit = (line, startChar, endChar, newText) => ({
    range: {start: {line, character: startChar}, end: {line, character: endChar}},
    newText,
})

// stub factory returning canned per-symbol rename results keyed by the rename position
const stubFactory = (resultsByName) => async () => ({
    async openDocument() {},
    async rename(relPath, position) { return resultsByName[`${relPath}:${position.character}`] },
    async close() {},
    kill() {},
})

const SOURCE = 'const getUser = 1\nconst getOrder = 2\nuse(getUser, getOrder)\n'

const graphWith = (nodes) => ({nodes, links: [], graphRevision: 'test'})

test('merges two renames into one atomic plan with per-file union of edits', async () => {
    const repoRoot = fixtureRepo({'a.js': SOURCE})
    const rawGraph = graphWith([
        node('a.js#getUser@1', 'getUser', 'a.js', 6, 13),
        node('a.js#getOrder@2', 'getOrder', 'a.js', 6, 14, 1),
    ])
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.js#getUser@1', newName: 'getCustomer'},
            {targetId: 'a.js#getOrder@2', newName: 'getPurchase'},
        ],
        clientFactory: stubFactory({
            'a.js:6': {files: [{file: 'a.js', edits: [lspEdit(0, 6, 13, 'getCustomer'), lspEdit(2, 4, 11, 'getCustomer')]}], outsideRepository: [], resourceOperations: 0},
        }),
    })
    // the stub keys on character 6 for both symbols (they share startChar); both get the same shape
    assert.equal(result.status, 'PLANNED', JSON.stringify(result))
    assert.equal(result.plan.operation, 'rename_related_symbols')
    assert.equal(result.plan.files.length, 1)
    assert.equal(result.renames.length, 2)
})

test('a swap (A->B, B->A) is planned with the simultaneous-semantics warning', async () => {
    const repoRoot = fixtureRepo({'a.js': SOURCE})
    const rawGraph = graphWith([
        node('a.js#getUser@1', 'getUser', 'a.js', 6, 13),
        node('a.js#getOrder@2', 'getOrder', 'a.js', 6, 14, 1),
    ])
    const responses = {
        'a.js:6': {files: [{file: 'a.js', edits: [lspEdit(0, 6, 13, 'x')]}], outsideRepository: [], resourceOperations: 0},
    }
    // two calls share the stub key; distinguish by call order
    let call = 0
    const factory = async () => ({
        async openDocument() {},
        async rename() {
            call += 1
            return call === 1
                ? {files: [{file: 'a.js', edits: [lspEdit(0, 6, 13, 'getOrder'), lspEdit(2, 4, 11, 'getOrder')]}], outsideRepository: [], resourceOperations: 0}
                : {files: [{file: 'a.js', edits: [lspEdit(1, 6, 14, 'getUser'), lspEdit(2, 13, 21, 'getUser')]}], outsideRepository: [], resourceOperations: 0}
        },
        async close() {},
        kill() {},
    })
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.js#getUser@1', newName: 'getOrder'},
            {targetId: 'a.js#getOrder@2', newName: 'getUser'},
        ],
        clientFactory: factory,
    })
    assert.equal(result.status, 'PLANNED')
    assert.ok(result.plan.warnings.includes('RENAME_CHAIN_SIMULTANEOUS'))
    // the sibling's old name is renamed away in the same atomic plan â€” shadowing is spurious here
    assert.equal(result.plan.warnings.includes('POSSIBLE_SHADOWING'), false)
    assert.equal(result.plan.files[0].edits.length, 4)
})

test('overlapping edits across renames block the whole plan as CONFLICT', async () => {
    const repoRoot = fixtureRepo({'a.js': SOURCE})
    const rawGraph = graphWith([
        node('a.js#getUser@1', 'getUser', 'a.js', 6, 13),
        node('a.js#getOrder@2', 'getOrder', 'a.js', 6, 14, 1),
    ])
    let call = 0
    const factory = async () => ({
        async openDocument() {},
        async rename() {
            call += 1
            // both renames claim overlapping ranges on line 3
            return {files: [{file: 'a.js', edits: [lspEdit(2, 4, 15, `v${call}`)]}], outsideRepository: [], resourceOperations: 0}
        },
        async close() {},
        kill() {},
    })
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.js#getUser@1', newName: 'one'},
            {targetId: 'a.js#getOrder@2', newName: 'two'},
        ],
        clientFactory: factory,
    })
    assert.equal(result.status, 'CONFLICT')
    assert.equal(result.conflicts.length, 1)
})

test('one failing sub-rename blocks everything: all-or-nothing', async () => {
    const repoRoot = fixtureRepo({'a.js': SOURCE})
    const rawGraph = graphWith([node('a.js#getUser@1', 'getUser', 'a.js', 6, 13)])
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.js#getUser@1', newName: 'getCustomer'},
            {targetId: 'a.js#missing@9', newName: 'whatever'},
        ],
        clientFactory: stubFactory({
            'a.js:6': {files: [{file: 'a.js', edits: [lspEdit(0, 6, 13, 'getCustomer')]}], outsideRepository: [], resourceOperations: 0},
        }),
    })
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].status, 'NOT_FOUND')
})

test('invalid inputs fail closed before any LSP work', async () => {
    const repoRoot = fixtureRepo({'a.js': SOURCE})
    const rawGraph = graphWith([node('a.js#getUser@1', 'getUser', 'a.js', 6, 13)])
    const call = (renames) => buildRelatedRenamePlan({repoRoot, rawGraph, renames, clientFactory: async () => { throw new Error('must not be called') }})
    assert.equal((await call([])).status, 'INVALID_RENAMES')
    assert.equal((await call([{targetId: 'a', newName: 'b'}, {targetId: 'a', newName: 'c'}])).status, 'INVALID_RENAMES')
    const tooMany = Array.from({length: 17}, (unused, index) => ({targetId: `id${index}`, newName: `n${index}`}))
    assert.equal((await call(tooMany)).status, 'INVALID_RENAMES')
})
