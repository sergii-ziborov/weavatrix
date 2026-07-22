import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildSqlRenamePlan} from '../src/analysis/sql-rename-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-sqlrename-'))
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repoRoot, path, '..'), {recursive: true})
        writeFileSync(join(repoRoot, path), content)
    }
    return repoRoot
}

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
        assert.equal(next.slice(start, end), edit.before)
        next = next.slice(0, start) + edit.after + next.slice(end)
    }
    return next
}

const tableNode = (id, label, kind = 'table') => ({id, source_file: id.slice(0, id.indexOf('#')), label, symbol_kind: kind})
const refLink = (source, target, line) => ({source, target, relation: 'references', usage: 'sql', confidence: 'INFERRED', line})

test('rename_table rewrites the definition and every scanned reference, across .sql and host code', () => {
    const repoRoot = fixtureRepo({
        'schema.sql': 'CREATE TABLE users (\n    id INT\n);\nSELECT id FROM users;\n',
        'app.ts': "const q = 'SELECT * FROM users WHERE id = 1'\n",
    })
    const rawGraph = {
        nodes: [tableNode('schema.sql#users@1', 'users'), {id: 'app.ts#q@1', source_file: 'app.ts', label: 'q'}],
        links: [
            refLink('schema.sql', 'schema.sql#users@1', 4),
            refLink('app.ts#q@1', 'schema.sql#users@1', 1),
        ],
    }
    const result = buildSqlRenamePlan({repoRoot, rawGraph, symbolId: 'schema.sql#users@1', newName: 'customers'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.completeness, 'PARTIAL')
    assert.ok(result.plan.warnings.includes('ORM_AND_DYNAMIC_SQL_INVISIBLE'))
    const byPath = Object.fromEntries(result.plan.files.map((file) => [file.path, file]))
    assert.equal(applyFile(repoRoot, byPath['schema.sql']), 'CREATE TABLE customers (\n    id INT\n);\nSELECT id FROM customers;\n')
    assert.equal(applyFile(repoRoot, byPath['app.ts']), "const q = 'SELECT * FROM customers WHERE id = 1'\n")
})

test('a quoted table name is matched and only the inner name rewritten', () => {
    const repoRoot = fixtureRepo({'schema.sql': 'CREATE TABLE "users" (\n    id INT\n);\n'})
    const rawGraph = {nodes: [tableNode('schema.sql#users@1', 'users')], links: []}
    const result = buildSqlRenamePlan({repoRoot, rawGraph, symbolId: 'schema.sql#users@1', newName: 'customers'})
    assert.equal(applyFile(repoRoot, result.plan.files[0]), 'CREATE TABLE "customers" (\n    id INT\n);\n')
})

test('qualified references on one line rewrite every occurrence of the table name', () => {
    const repoRoot = fixtureRepo({'schema.sql': 'CREATE TABLE users (id INT);\nSELECT users.id FROM users;\n'})
    const rawGraph = {
        nodes: [tableNode('schema.sql#users@1', 'users')],
        links: [refLink('schema.sql', 'schema.sql#users@1', 2)],
    }
    const result = buildSqlRenamePlan({repoRoot, rawGraph, symbolId: 'schema.sql#users@1', newName: 'customers'})
    assert.ok(result.plan.warnings.includes('MULTIPLE_OCCURRENCES_PER_LINE'))
    assert.equal(applyFile(repoRoot, result.plan.files[0]), 'CREATE TABLE customers (id INT);\nSELECT customers.id FROM customers;\n')
})

test('rename_field rewrites only the definition and marks usages UNPROVEN', () => {
    const repoRoot = fixtureRepo({'schema.sql': 'CREATE TABLE users (\n    email TEXT\n);\nSELECT email FROM users;\n'})
    const rawGraph = {
        nodes: [tableNode('schema.sql#users@1', 'users'), {id: 'schema.sql#email@2', source_file: 'schema.sql', label: 'email', symbol_kind: 'column', member_of: 'users'}],
        links: [],
    }
    const result = buildSqlRenamePlan({repoRoot, rawGraph, symbolId: 'schema.sql#email@2', newName: 'email_address'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.plan.operation, 'rename_field')
    assert.ok(result.plan.warnings.includes('COLUMN_USAGES_NOT_TRACKED'))
    // only line 2 (the definition) is edited; the SELECT usage on line 4 is NOT touched
    assert.equal(applyFile(repoRoot, result.plan.files[0]), 'CREATE TABLE users (\n    email_address TEXT\n);\nSELECT email FROM users;\n')
})

test('a reference the scanner recorded but not on the recorded line is UNCERTAIN, not misplaced', () => {
    const repoRoot = fixtureRepo({
        'schema.sql': 'CREATE TABLE users (id INT);\n',
        'app.ts': "const q = `\n  SELECT *\n  FROM users\n`\n",
    })
    // the embedded-SQL ref line points at the SELECT keyword line (2), but 'users' is on line 3
    const rawGraph = {
        nodes: [tableNode('schema.sql#users@1', 'users'), {id: 'app.ts#q@1', source_file: 'app.ts', label: 'q'}],
        links: [refLink('app.ts#q@1', 'schema.sql#users@1', 2)],
    }
    const result = buildSqlRenamePlan({repoRoot, rawGraph, symbolId: 'schema.sql#users@1', newName: 'customers'})
    assert.ok(result.plan.uncertainReferences.some((ref) => ref.reason === 'REFERENCE_NOT_ON_RECORDED_LINE'))
    // schema.sql definition still rewritten; app.ts not touched (would be a wrong-line edit)
    assert.deepEqual(result.plan.files.map((file) => file.path), ['schema.sql'])
})

test('expected failure modes are explicit statuses', () => {
    const repoRoot = fixtureRepo({'schema.sql': 'CREATE TABLE users (id INT);\n', 'a.ts': 'export const x = 1\n'})
    const rawGraph = {
        nodes: [tableNode('schema.sql#users@1', 'users'), {id: 'a.ts#x@1', source_file: 'a.ts', label: 'x', symbol_kind: 'const'}],
        links: [],
    }
    const call = (over) => buildSqlRenamePlan({repoRoot, rawGraph, symbolId: 'schema.sql#users@1', newName: 'customers', ...over})
    assert.equal(call({symbolId: 'a.ts#x@1'}).status, 'NOT_SUPPORTED')
    assert.equal(call({symbolId: 'schema.sql#gone@9'}).status, 'NOT_FOUND')
    assert.equal(call({newName: '1bad'}).status, 'INVALID_NEW_NAME')
    assert.equal(call({newName: 'users'}).status, 'NO_CHANGE')
})
