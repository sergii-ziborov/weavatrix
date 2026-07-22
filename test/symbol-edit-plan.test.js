import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildSymbolEditPlan} from '../src/analysis/symbol-edit-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-symedit-'))
    for (const [path, content] of Object.entries(files)) writeFileSync(join(repoRoot, path), content)
    return repoRoot
}

// test-side reference applier: bottom-up splice by the plan's 1-based/0-based positions
const applyPlanToText = (content, plan) => {
    const offsetOf = (line, character) => {
        let lineStart = 0
        for (let current = 1; current < line; current += 1) lineStart = content.indexOf('\n', lineStart) + 1
        return lineStart + character
    }
    const edits = [...plan.files[0].edits].sort((a, b) => offsetOf(b.startLine, b.startChar) - offsetOf(a.startLine, a.startChar))
    let next = content
    for (const edit of edits) {
        const start = offsetOf(edit.startLine, edit.startChar)
        const end = offsetOf(edit.endLine, edit.endChar)
        assert.equal(next.slice(start, end), edit.before)
        next = next.slice(0, start) + edit.after + next.slice(end)
    }
    return next
}

const TS_SOURCE = 'const keep = 1\nexport function helper(a: number) {\n    return a\n}\nconst tail = 2\n'

const helperNode = (overrides = {}) => ({
    id: 'a.ts#helper@2',
    label: 'helper',
    source_file: 'a.ts',
    exported: true,
    source_range: {start: {line: 1, character: 0}, end: {line: 3, character: 1}},
    ...overrides,
})

const graphWith = (nodes) => ({nodes, links: [], graphRevision: 'test'})

test('replace_symbol_body emits a hash-bound plan whose application yields the intended file', async () => {
    const repoRoot = fixtureRepo({'a.ts': TS_SOURCE})
    const body = 'export function helper(a: number) {\n    return a * 2\n}'
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([helperNode()]), targetId: 'a.ts#helper@2', operation: 'replace_symbol_body', content: body})
    assert.equal(result.status, 'PLANNED', JSON.stringify(result))
    assert.equal(result.syntaxCheck, 'PARSES')
    assert.equal(result.plan.files[0].edits[0].provenance, 'EXTRACTED')
    assert.ok(result.plan.warnings.includes('PUBLIC_API_SYMBOL'))
    const applied = applyPlanToText(TS_SOURCE, result.plan)
    assert.equal(applied, 'const keep = 1\nexport function helper(a: number) {\n    return a * 2\n}\nconst tail = 2\n')
})

test('a replacement that would break the parse is refused with SYNTAX_ERROR', async () => {
    const repoRoot = fixtureRepo({'a.ts': TS_SOURCE})
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([helperNode()]), targetId: 'a.ts#helper@2', operation: 'replace_symbol_body', content: 'export function helper( {'})
    assert.equal(result.status, 'SYNTAX_ERROR')
    assert.match(result.reason, /does not parse/)
})

test('insert_before_symbol inserts a whole line above the declaration', async () => {
    const repoRoot = fixtureRepo({'a.ts': TS_SOURCE})
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([helperNode()]), targetId: 'a.ts#helper@2', operation: 'insert_before_symbol', content: '/** doubles */'})
    assert.equal(result.status, 'PLANNED')
    const applied = applyPlanToText(TS_SOURCE, result.plan)
    assert.equal(applied, 'const keep = 1\n/** doubles */\nexport function helper(a: number) {\n    return a\n}\nconst tail = 2\n')
})

test('insert_after_symbol inserts on the line after the declaration', async () => {
    const repoRoot = fixtureRepo({'a.ts': TS_SOURCE})
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([helperNode()]), targetId: 'a.ts#helper@2', operation: 'insert_after_symbol', content: 'export const twice = (n: number) => helper(n)'})
    assert.equal(result.status, 'PLANNED')
    const applied = applyPlanToText(TS_SOURCE, result.plan)
    assert.equal(applied, 'const keep = 1\nexport function helper(a: number) {\n    return a\n}\nexport const twice = (n: number) => helper(n)\nconst tail = 2\n')
})

test('insert_after_symbol at EOF without a trailing newline prepends one', async () => {
    const source = 'export function last() {\n    return 1\n}'
    const repoRoot = fixtureRepo({'a.ts': source})
    const node = helperNode({id: 'a.ts#last@1', label: 'last', source_range: {start: {line: 0, character: 0}, end: {line: 2, character: 1}}})
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([node]), targetId: 'a.ts#last@1', operation: 'insert_after_symbol', content: 'export const after = 2'})
    assert.equal(result.status, 'PLANNED', JSON.stringify(result))
    const applied = applyPlanToText(source, result.plan)
    assert.equal(applied, 'export function last() {\n    return 1\n}\nexport const after = 2')
})

test('works for non-JS languages from the parser range, with the syntax gate not applicable', async () => {
    const source = 'def helper():\n    return 1\n\nprint(helper())\n'
    const repoRoot = fixtureRepo({'util.py': source})
    const node = {
        id: 'util.py#helper@1',
        label: 'helper',
        source_file: 'util.py',
        source_range: {start: {line: 0, character: 0}, end: {line: 1, character: 12}},
    }
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([node]), targetId: 'util.py#helper@1', operation: 'replace_symbol_body', content: 'def helper():\n    return 2'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.syntaxCheck, 'NOT_APPLICABLE_FOR_LANGUAGE')
    const applied = applyPlanToText(source, result.plan)
    assert.equal(applied, 'def helper():\n    return 2\n\nprint(helper())\n')
})

test('expected failure modes are explicit statuses, never wrong plans', async () => {
    const repoRoot = fixtureRepo({'a.ts': TS_SOURCE})
    const rawGraph = graphWith([helperNode(), helperNode({id: 'a.ts#bare@9', source_range: undefined})])
    const call = (overrides) => buildSymbolEditPlan({repoRoot, rawGraph, targetId: 'a.ts#helper@2', operation: 'replace_symbol_body', content: 'x', ...overrides})
    assert.equal((await call({targetId: 'nope#x@1'})).status, 'NOT_FOUND')
    assert.equal((await call({targetId: 'a.ts#bare@9'})).status, 'NOT_SUPPORTED')
    assert.equal((await call({operation: 'rename_symbol'})).status, 'INVALID_OPERATION')
    assert.equal((await call({content: ''})).status, 'INVALID_CONTENT')
    const current = TS_SOURCE.slice(15, TS_SOURCE.indexOf('}\n') + 1)
    assert.equal((await call({content: current})).status, 'NO_CHANGE')
    const stale = graphWith([helperNode({source_range: {start: {line: 90, character: 0}, end: {line: 95, character: 1}}})])
    assert.equal((await buildSymbolEditPlan({repoRoot, rawGraph: stale, targetId: 'a.ts#helper@2', operation: 'replace_symbol_body', content: 'x'})).status, 'STALE_GRAPH')
})

test('a zero-width range refuses replace_symbol_body instead of silently inserting', async () => {
    const source = 'CREATE TABLE users (id INT);\n'
    const repoRoot = fixtureRepo({'schema.sql': source})
    const node = {
        id: 'schema.sql#users@1',
        label: 'users',
        source_file: 'schema.sql',
        source_range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}},
    }
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([node]), targetId: 'schema.sql#users@1', operation: 'replace_symbol_body', content: 'CREATE TABLE users (id BIGINT);'})
    assert.equal(result.status, 'NOT_SUPPORTED')
    assert.match(result.reason, /zero-width/)
})

test('a character position past the line end is STALE_GRAPH, never a spilled offset', async () => {
    const repoRoot = fixtureRepo({'a.ts': TS_SOURCE})
    const overflow = graphWith([helperNode({source_range: {start: {line: 1, character: 0}, end: {line: 1, character: 400}}})])
    assert.equal((await buildSymbolEditPlan({repoRoot, rawGraph: overflow, targetId: 'a.ts#helper@2', operation: 'replace_symbol_body', content: 'x'})).status, 'STALE_GRAPH')
})

test('non-numeric range coordinates are STALE_GRAPH, not NaN offsets', async () => {
    const repoRoot = fixtureRepo({'a.ts': TS_SOURCE})
    const broken = graphWith([helperNode({source_range: {start: {line: 'x', character: 0}, end: {line: 3, character: 1}}})])
    assert.equal((await buildSymbolEditPlan({repoRoot, rawGraph: broken, targetId: 'a.ts#helper@2', operation: 'replace_symbol_body', content: 'x'})).status, 'STALE_GRAPH')
})

test('insertions into CRLF files use CRLF, never mixed line endings', async () => {
    const source = 'const a = 1\r\nexport function helper() {\r\n    return 1\r\n}\r\nconst z = 2\r\n'
    const repoRoot = fixtureRepo({'a.ts': source})
    const node = helperNode({source_range: {start: {line: 1, character: 0}, end: {line: 3, character: 1}}})
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([node]), targetId: 'a.ts#helper@2', operation: 'insert_before_symbol', content: '// note'})
    assert.equal(result.status, 'PLANNED')
    const applied = applyPlanToText(source, result.plan)
    assert.equal(applied, 'const a = 1\r\n// note\r\nexport function helper() {\r\n    return 1\r\n}\r\nconst z = 2\r\n')
    assert.equal(applied.includes('note\n'.replace('\r', '')) && !applied.includes('// note\r\n'), false)
})

test('a clean parse of a .js file is only PARSES_PERMISSIVE with an explicit warning', async () => {
    const source = 'function helper() {\n    return 1\n}\n'
    const repoRoot = fixtureRepo({'a.js': source})
    const node = helperNode({id: 'a.js#helper@1', source_file: 'a.js', exported: false, source_range: {start: {line: 0, character: 0}, end: {line: 2, character: 1}}})
    const result = await buildSymbolEditPlan({repoRoot, rawGraph: graphWith([node]), targetId: 'a.js#helper@1', operation: 'replace_symbol_body', content: 'function helper() {\n    return 2\n}'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.syntaxCheck, 'PARSES_PERMISSIVE')
    assert.ok(result.plan.warnings.includes('SYNTAX_CHECK_PERMISSIVE'))
})
