import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildRenamePlan} from '../src/precision/rename-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-rename-'))
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repoRoot, path, '..'), {recursive: true})
        writeFileSync(join(repoRoot, path), content)
    }
    return repoRoot
}

const graphWith = (nodes, links = []) => ({nodes, links, graphRevision: 'test-revision'})

const getUserNode = (overrides = {}) => ({
    id: 'src/a.js#getUser@1',
    label: 'getUser',
    source_file: 'src/a.js',
    exported: true,
    selection_start: {line: 0, character: 6},
    selection_end: {line: 0, character: 13},
    ...overrides,
})

const stubClient = (renameResult) => async () => ({
    async openDocument() {},
    async rename() { return renameResult },
    async close() {},
    kill() {},
})

const lspEdit = (line, startChar, endChar, newText) => ({
    range: {start: {line, character: startChar}, end: {line, character: endChar}},
    newText,
})

test('assembles a hash-bound plan and reports the uncovered string occurrence honestly', async () => {
    const repoRoot = fixtureRepo({
        'src/a.js': "const getUser = 1\nexport {getUser}\nconst key = 'getUser'\n",
    })
    const result = await buildRenamePlan({
        repoRoot,
        rawGraph: graphWith([getUserNode()]),
        targetId: 'src/a.js#getUser@1',
        newName: 'getCustomer',
        clientFactory: stubClient({
            files: [{file: 'src/a.js', edits: [lspEdit(0, 6, 13, 'getCustomer'), lspEdit(1, 8, 15, 'getCustomer')]}],
            outsideRepository: [],
            resourceOperations: 0,
        }),
    })
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.oldName, 'getUser')
    assert.equal(result.completeness, 'PARTIAL')
    const plan = result.plan
    assert.equal(plan.schemaVersion, 'weavatrix.edit-plan.v1')
    assert.equal(plan.files.length, 1)
    assert.match(plan.files[0].sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(plan.files[0].edits.map((edit) => edit.before), ['getUser', 'getUser'])
    assert.deepEqual(plan.files[0].edits.map((edit) => edit.provenance), ['EXACT_LSP', 'EXACT_LSP'])
    // the string literal on line 3 was not edited and must be reported, not guessed
    assert.equal(plan.uncertainReferences.length, 1)
    assert.equal(plan.uncertainReferences[0].kind, 'UNCOVERED_OCCURRENCE')
    assert.equal(plan.uncertainReferences[0].line, 3)
    assert.ok(plan.warnings.includes('PUBLIC_API_SYMBOL'))
})

test('graph references in files the LSP did not touch become uncertainReferences', async () => {
    const repoRoot = fixtureRepo({
        'src/a.js': 'const getUser = 1\n',
        'src/dynamic.py': 'call("getUser")\n',
    })
    const rawGraph = graphWith(
        [getUserNode({exported: false}), {id: 'src/dynamic.py#call@1', label: 'call', source_file: 'src/dynamic.py'}],
        [{source: 'src/dynamic.py#call@1', target: 'src/a.js#getUser@1', type: 'references', confidence: 'INFERRED'}],
    )
    const result = await buildRenamePlan({
        repoRoot,
        rawGraph,
        targetId: 'src/a.js#getUser@1',
        newName: 'getCustomer',
        clientFactory: stubClient({
            files: [{file: 'src/a.js', edits: [lspEdit(0, 6, 13, 'getCustomer')]}],
            outsideRepository: [],
            resourceOperations: 0,
        }),
    })
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.completeness, 'PARTIAL')
    const graphRef = result.plan.uncertainReferences.find((ref) => ref.kind === 'GRAPH_REFERENCE_WITHOUT_EDIT')
    assert.equal(graphRef.path, 'src/dynamic.py')
    assert.equal(graphRef.provenance, 'INFERRED')
})

test('edit targets outside the repository are reported, never silently dropped', async () => {
    const repoRoot = fixtureRepo({'src/a.js': 'const getUser = 1\n'})
    const result = await buildRenamePlan({
        repoRoot,
        rawGraph: graphWith([getUserNode({exported: false})]),
        targetId: 'src/a.js#getUser@1',
        newName: 'getCustomer',
        clientFactory: stubClient({
            files: [{file: 'src/a.js', edits: [lspEdit(0, 6, 13, 'getCustomer')]}],
            outsideRepository: ['file:///outside/node_modules/lib.d.ts'],
            resourceOperations: 0,
        }),
    })
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.completeness, 'PARTIAL')
    assert.equal(result.plan.notModified.length, 1)
    assert.match(result.plan.notModified[0].reason, /outside the repository/)
})

test('non-JS/TS symbols get NOT_SUPPORTED plus the graph reference inventory', async () => {
    const repoRoot = fixtureRepo({'main.py': 'def get_user():\n    pass\n'})
    const rawGraph = graphWith(
        [
            {id: 'main.py#get_user@1', label: 'get_user', source_file: 'main.py'},
            {id: 'app.py#run@1', label: 'run', source_file: 'app.py'},
        ],
        [{source: 'app.py#run@1', target: 'main.py#get_user@1', type: 'calls', confidence: 'RESOLVED'}],
    )
    const result = await buildRenamePlan({repoRoot, rawGraph, targetId: 'main.py#get_user@1', newName: 'fetch_user'})
    assert.equal(result.status, 'NOT_SUPPORTED')
    assert.equal(result.references.length, 1)
    assert.equal(result.references[0].path, 'app.py')
})

test('invalid identifiers, unknown symbols and no-op renames fail closed', async () => {
    const repoRoot = fixtureRepo({'src/a.js': 'const getUser = 1\n'})
    const rawGraph = graphWith([getUserNode()])
    assert.equal((await buildRenamePlan({repoRoot, rawGraph, targetId: 'src/a.js#getUser@1', newName: '123bad'})).status, 'INVALID_NEW_NAME')
    assert.equal((await buildRenamePlan({repoRoot, rawGraph, targetId: 'nope#x@1', newName: 'ok'})).status, 'NOT_FOUND')
    assert.equal((await buildRenamePlan({repoRoot, rawGraph, targetId: 'src/a.js#getUser@1', newName: 'getUser'})).status, 'NO_CHANGE')
})

test('a selection that no longer matches the file is STALE_GRAPH, not a wrong plan', async () => {
    const repoRoot = fixtureRepo({'src/a.js': 'x\n'})
    const result = await buildRenamePlan({
        repoRoot,
        rawGraph: graphWith([getUserNode({selection_start: {line: 5, character: 0}, selection_end: {line: 5, character: 7}})]),
        targetId: 'src/a.js#getUser@1',
        newName: 'getCustomer',
    })
    assert.equal(result.status, 'STALE_GRAPH')
})

test('real language server: cross-file rename produces edits in the importer too', {timeout: 120_000}, async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function getUser(id: string) {\n    return id\n}\n',
        'b.ts': "import {getUser} from './a'\n\nexport const load = () => getUser('42')\n",
    })
    const rawGraph = graphWith([
        {
            id: 'a.ts#getUser@1',
            label: 'getUser',
            source_file: 'a.ts',
            exported: true,
            selection_start: {line: 0, character: 16},
            selection_end: {line: 0, character: 23},
        },
        {id: 'b.ts#load@3', label: 'load', source_file: 'b.ts'},
    ], [{source: 'b.ts#load@3', target: 'a.ts#getUser@1', type: 'calls'}])
    const result = await buildRenamePlan({repoRoot, rawGraph, targetId: 'a.ts#getUser@1', newName: 'getCustomer', timeoutMs: 60_000})
    assert.equal(result.status, 'PLANNED', JSON.stringify(result))
    const paths = result.plan.files.map((file) => file.path).sort()
    assert.deepEqual(paths, ['a.ts', 'b.ts'])
    for (const file of result.plan.files) {
        for (const edit of file.edits) {
            assert.equal(edit.before, 'getUser')
            assert.equal(edit.after, 'getCustomer')
        }
    }
    // b.ts was edited by the LSP, so there must be no uncovered occurrences left there
    assert.equal(result.plan.uncertainReferences.length, 0)
    assert.equal(result.completeness, 'COMPLETE')
})
