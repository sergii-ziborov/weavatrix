import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildRelatedRenamePlan} from '../src/precision/related-rename-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-related-sess-'))
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

const graphWith = (nodes) => ({nodes, links: [], graphRevision: 'test'})

test('the default factory shares ONE client and one dedupe map across the whole batch', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export const one = 1\n',
        'b.ts': 'export const two = 2\n',
    })
    const rawGraph = graphWith([
        node('a.ts#one@1', 'one', 'a.ts', 13, 16),
        node('b.ts#two@1', 'two', 'b.ts', 13, 16),
    ])
    const calls = {created: 0, opened: [], closed: 0}
    const createClient = async () => {
        calls.created += 1
        return {
            async openDocument(relPath) { calls.opened.push(relPath) },
            async rename(relPath) {
                return {files: [{file: relPath, edits: [lspEdit(0, 13, 16, 'renamed')]}], outsideRepository: [], resourceOperations: 0}
            },
            async close() { calls.closed += 1 },
            kill() {},
        }
    }
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.ts#one@1', newName: 'uno'},
            {targetId: 'b.ts#two@1', newName: 'dos'},
        ],
        createClient,
    })
    assert.equal(result.status, 'PLANNED')
    assert.equal(calls.created, 1)
    // each unique file reaches the real client exactly once across the batch
    assert.deepEqual([...calls.opened].sort(), ['a.ts', 'b.ts'])
    // sub-plan close() calls are no-ops; the shared client closes exactly once at the end
    assert.equal(calls.closed, 1)
})

test('mid-batch disk drift of a session file fails the batch closed as BLOCKED', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export const one = 1\nuse(two)\n',
        'b.ts': 'export const two = 2\n',
    })
    // b.ts is a graph reference of rename 1 (opened into the session) AND the declaring
    // file of rename 2 (re-opened) â€” the drift guard must catch the mid-batch change
    const rawGraph = graphWith([
        node('a.ts#one@1', 'one', 'a.ts', 13, 16),
        node('b.ts#two@1', 'two', 'b.ts', 13, 16),
    ])
    rawGraph.links = [{source: 'b.ts#two@1', target: 'a.ts#one@1', type: 'references'}]
    let renameCount = 0
    const createClient = async () => ({
        async openDocument() {},
        async rename(relPath) {
            renameCount += 1
            if (renameCount === 1) writeFileSync(join(repoRoot, 'b.ts'), 'export const two = 2 // drifted\n')
            return {files: [{file: relPath, edits: [lspEdit(0, 13, 16, 'renamed')]}], outsideRepository: [], resourceOperations: 0}
        },
        async close() {},
        kill() {},
    })
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.ts#one@1', newName: 'uno'},
            {targetId: 'b.ts#two@1', newName: 'dos'},
        ],
        createClient,
    })
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.failures[0].status, 'LSP_FAILED')
    assert.match(result.failures[0].reason, /drifted between sub-renames/)
})

test('the same file with two different hashes across sub-plans is a snapshot-drift CONFLICT', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export const one = 1\n',
        'shared.ts': 'use(one); use(two)\n',
        'b.ts': 'export const two = 2\n',
    })
    const rawGraph = graphWith([
        node('a.ts#one@1', 'one', 'a.ts', 13, 16),
        node('b.ts#two@1', 'two', 'b.ts', 13, 16),
    ])
    // custom per-sub-rename factory bypasses the shared session, modeling LSP results
    // that both touch shared.ts while the disk content changes in between
    let call = 0
    const factory = async () => ({
        async openDocument() {},
        async rename() {
            call += 1
            if (call === 1) {
                return {files: [{file: 'shared.ts', edits: [lspEdit(0, 4, 7, 'uno')]}], outsideRepository: [], resourceOperations: 0}
            }
            writeFileSync(join(repoRoot, 'shared.ts'), 'use(one); use(two) // drifted\n')
            return {files: [{file: 'shared.ts', edits: [lspEdit(0, 14, 17, 'dos')]}], outsideRepository: [], resourceOperations: 0}
        },
        async close() {},
        kill() {},
    })
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.ts#one@1', newName: 'uno'},
            {targetId: 'b.ts#two@1', newName: 'dos'},
        ],
        clientFactory: factory,
    })
    assert.equal(result.status, 'CONFLICT')
    assert.match(result.conflicts[0].reason, /snapshot drift/)
})

test('a client-factory startup failure is a BLOCKED batch, not an escaped exception', async () => {
    const repoRoot = fixtureRepo({'a.ts': 'export const one = 1\n'})
    const rawGraph = graphWith([node('a.ts#one@1', 'one', 'a.ts', 13, 16)])
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [{targetId: 'a.ts#one@1', newName: 'uno'}],
        createClient: async () => { throw new Error('tsserver refused to start') },
    })
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.failures[0].status, 'LSP_FAILED')
    assert.match(result.failures[0].reason, /refused to start/)
})

test('real language server: coordinated rename of two symbols shares one session', {timeout: 120_000}, async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function getUser() {\n    return 1\n}\nexport function getOrder() {\n    return 2\n}\n',
        'b.ts': "import {getUser, getOrder} from './a'\n\nexport const both = () => getUser() + getOrder()\n",
    })
    const rawGraph = graphWith([
        {
            id: 'a.ts#getUser@1', label: 'getUser', source_file: 'a.ts', exported: true,
            selection_start: {line: 0, character: 16}, selection_end: {line: 0, character: 23},
        },
        {
            id: 'a.ts#getOrder@4', label: 'getOrder', source_file: 'a.ts', exported: true,
            selection_start: {line: 3, character: 16}, selection_end: {line: 3, character: 24},
        },
        {id: 'b.ts#both@3', label: 'both', source_file: 'b.ts'},
    ])
    rawGraph.links = [
        {source: 'b.ts#both@3', target: 'a.ts#getUser@1', type: 'calls'},
        {source: 'b.ts#both@3', target: 'a.ts#getOrder@4', type: 'calls'},
    ]
    const result = await buildRelatedRenamePlan({
        repoRoot,
        rawGraph,
        renames: [
            {targetId: 'a.ts#getUser@1', newName: 'getCustomer'},
            {targetId: 'a.ts#getOrder@4', newName: 'getPurchase'},
        ],
        timeoutMs: 60_000,
    })
    assert.equal(result.status, 'PLANNED', JSON.stringify(result))
    assert.equal(result.completeness, 'COMPLETE')
    const paths = result.plan.files.map((file) => file.path).sort()
    assert.deepEqual(paths, ['a.ts', 'b.ts'])
    const allAfters = result.plan.files.flatMap((file) => file.edits.map((edit) => edit.after))
    assert.ok(allAfters.includes('getCustomer') && allAfters.includes('getPurchase'))
})
