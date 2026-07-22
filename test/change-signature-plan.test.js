import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildChangeSignaturePlan} from '../src/analysis/change-signature-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-sig-'))
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repoRoot, path, '..'), {recursive: true})
        writeFileSync(join(repoRoot, path), content)
    }
    return repoRoot
}

// applies one file's plan edits bottom-up, verifying before-text, to prove correctness
const applyFile = (repoRoot, planFile) => {
    const content = readFileSync(join(repoRoot, planFile.path), 'utf8')
    const offset = (line, char) => {
        let start = 0
        for (let current = 1; current < line; current += 1) start = content.indexOf('\n', start) + 1
        return start + char
    }
    const edits = [...planFile.edits].sort((a, b) => offset(b.startLine, b.startChar) - offset(a.startLine, a.startChar))
    let next = content
    for (const edit of edits) {
        const start = offset(edit.startLine, edit.startChar)
        const end = offset(edit.endLine, edit.endChar)
        assert.equal(next.slice(start, end), edit.before, `before mismatch at ${edit.startLine}:${edit.startChar}`)
        next = next.slice(0, start) + edit.after + next.slice(end)
    }
    return next
}

const symNode = (id, label) => ({id, source_file: id.slice(0, id.indexOf('#')), label})
const callLink = (source, target, line) => ({source, target, relation: 'calls', line})

test('add_parameter with a default edits only the declaration; call sites stay valid', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function getUser(id: string) {\n    return id\n}\n',
        'b.ts': "import {getUser} from './a'\nexport const x = getUser('1')\n",
    })
    const rawGraph = {
        nodes: [symNode('a.ts#getUser@1', 'getUser'), symNode('b.ts#x@2', 'x')],
        links: [callLink('b.ts#x@2', 'a.ts#getUser@1', 2)],
    }
    const result = await buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#getUser@1', operation: {kind: 'add_parameter', name: 'opts', default: '{}'}})
    assert.equal(result.status, 'PLANNED')
    // only a.ts is edited (declaration); b.ts call is still valid without the new arg
    assert.deepEqual(result.plan.files.map((file) => file.path), ['a.ts'])
    const applied = applyFile(repoRoot, result.plan.files[0])
    assert.equal(applied, 'export function getUser(id: string, opts = {}) {\n    return id\n}\n')
})

test('add_parameter WITHOUT a default flags every call site as needing a value', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function getUser(id: string) {\n    return id\n}\n',
        'b.ts': "import {getUser} from './a'\nexport const x = getUser('1')\n",
    })
    const rawGraph = {
        nodes: [symNode('a.ts#getUser@1', 'getUser'), symNode('b.ts#x@2', 'x')],
        links: [callLink('b.ts#x@2', 'a.ts#getUser@1', 2)],
    }
    const result = await buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#getUser@1', operation: {kind: 'add_parameter', name: 'opts'}})
    assert.equal(result.status, 'PLANNED')
    assert.ok(result.plan.warnings.includes('ADDED_PARAMETER_HAS_NO_DEFAULT'))
    assert.ok(result.plan.uncertainReferences.some((ref) => ref.reason === 'CALL_SITE_NEEDS_ARGUMENT_VALUE'))
})

test('remove_parameter removes the declaration param and every call-site argument, byte-exact', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function getUser(id: string, opts: Opts) {\n    return id\n}\n',
        'b.ts': "import {getUser} from './a'\nexport const x = getUser('1', {deep: true})\n",
    })
    const rawGraph = {
        nodes: [symNode('a.ts#getUser@1', 'getUser'), symNode('b.ts#x@2', 'x')],
        links: [callLink('b.ts#x@2', 'a.ts#getUser@1', 2)],
    }
    const result = await buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#getUser@1', operation: {kind: 'remove_parameter', index: 1}})
    assert.equal(result.status, 'PLANNED')
    const byPath = Object.fromEntries(result.plan.files.map((file) => [file.path, file]))
    assert.equal(applyFile(repoRoot, byPath['a.ts']), 'export function getUser(id: string) {\n    return id\n}\n')
    assert.equal(applyFile(repoRoot, byPath['b.ts']), "import {getUser} from './a'\nexport const x = getUser('1')\n")
})

test('remove_parameter of a middle argument keeps the list well-formed', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function f(a: number, b: number, c: number) {\n    return a\n}\n',
        'b.ts': "import {f} from './a'\nexport const y = f(1, 2, 3)\n",
    })
    const rawGraph = {
        nodes: [symNode('a.ts#f@1', 'f'), symNode('b.ts#y@2', 'y')],
        links: [callLink('b.ts#y@2', 'a.ts#f@1', 2)],
    }
    const result = await buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#f@1', operation: {kind: 'remove_parameter', index: 1}})
    const byPath = Object.fromEntries(result.plan.files.map((file) => [file.path, file]))
    assert.equal(applyFile(repoRoot, byPath['a.ts']), 'export function f(a: number, c: number) {\n    return a\n}\n')
    assert.equal(applyFile(repoRoot, byPath['b.ts']), "import {f} from './a'\nexport const y = f(1, 3)\n")
})

test('a spread call site is UNCERTAIN, never rewritten', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function f(a: number, b: number) {\n    return a\n}\n',
        'b.ts': "import {f} from './a'\nexport const y = f(...pair)\n",
    })
    const rawGraph = {
        nodes: [symNode('a.ts#f@1', 'f'), symNode('b.ts#y@2', 'y')],
        links: [callLink('b.ts#y@2', 'a.ts#f@1', 2)],
    }
    const result = await buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#f@1', operation: {kind: 'remove_parameter', index: 1}})
    assert.ok(result.plan.uncertainReferences.some((ref) => ref.reason === 'SPREAD_ARGUMENT'))
    // b.ts is not edited; only the declaration is
    assert.deepEqual(result.plan.files.map((file) => file.path), ['a.ts'])
})

test('a call passing fewer args than the removed index needs no call-site edit', async () => {
    const repoRoot = fixtureRepo({
        'a.ts': 'export function f(a: number, b?: number) {\n    return a\n}\n',
        'b.ts': "import {f} from './a'\nexport const y = f(1)\n",
    })
    const rawGraph = {
        nodes: [symNode('a.ts#f@1', 'f'), symNode('b.ts#y@2', 'y')],
        links: [callLink('b.ts#y@2', 'a.ts#f@1', 2)],
    }
    const result = await buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#f@1', operation: {kind: 'remove_parameter', index: 1}})
    assert.deepEqual(result.plan.files.map((file) => file.path), ['a.ts'])
})

test('the plan is always PARTIAL and says call sites came from graph edges', async () => {
    const repoRoot = fixtureRepo({'a.ts': 'export function f(a: number) {\n    return a\n}\n'})
    const rawGraph = {nodes: [symNode('a.ts#f@1', 'f')], links: []}
    const result = await buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#f@1', operation: {kind: 'add_parameter', name: 'b', default: '0'}})
    assert.equal(result.completeness, 'PARTIAL')
    assert.ok(result.plan.warnings.includes('CALL_SITES_FROM_GRAPH_ONLY'))
})

test('expected failure modes are explicit statuses', async () => {
    const repoRoot = fixtureRepo({'a.ts': 'export function f(a: number) {\n    return a\n}\n', 'x.py': 'def g(): pass\n'})
    const rawGraph = {nodes: [symNode('a.ts#f@1', 'f'), symNode('x.py#g@1', 'g')], links: []}
    const call = (over) => buildChangeSignaturePlan({repoRoot, rawGraph, symbolId: 'a.ts#f@1', operation: {kind: 'add_parameter', name: 'b'}, ...over})
    assert.equal((await call({symbolId: 'a.ts'})).status, 'NOT_A_SYMBOL')
    assert.equal((await call({symbolId: 'a.ts#gone@9'})).status, 'NOT_FOUND')
    assert.equal((await call({symbolId: 'x.py#g@1'})).status, 'NOT_SUPPORTED')
    assert.equal((await call({operation: {kind: 'reorder'}})).status, 'INVALID_OPERATION')
    assert.equal((await call({operation: {kind: 'remove_parameter', index: 9}})).status, 'INVALID_OPERATION')
})
