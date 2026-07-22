import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildGraphRenamePlan} from '../src/analysis/graph-rename-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-graphrename-'))
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

const symNode = (id, label) => ({id, source_file: id.slice(0, id.indexOf('#')), label})
const callLink = (source, target, line, provenance = 'RESOLVED') => ({source, target, relation: 'calls', line, provenance})

test('renames a Python function declaration and its unambiguous call sites', () => {
    const repoRoot = fixtureRepo({
        'util.py': 'def get_user(x):\n    return x\n',
        'app.py': 'from util import get_user\nvalue = get_user(1)\n',
    })
    const rawGraph = {
        nodes: [symNode('util.py#get_user@1', 'get_user'), symNode('app.py#value@2', 'value')],
        links: [
            {source: 'app.py', target: 'util.py#get_user@1', relation: 'references', line: 1, provenance: 'RESOLVED'},
            callLink('app.py#value@2', 'util.py#get_user@1', 2),
        ],
    }
    const result = buildGraphRenamePlan({repoRoot, rawGraph, symbolId: 'util.py#get_user@1', newName: 'fetch_user'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.language, 'py')
    assert.equal(result.completeness, 'PARTIAL')
    assert.ok(result.plan.warnings.includes('NO_LSP_COMPLETENESS_UNPROVEN'))
    const byPath = Object.fromEntries(result.plan.files.map((file) => [file.path, file]))
    assert.equal(applyFile(repoRoot, byPath['util.py']), 'def fetch_user(x):\n    return x\n')
    assert.equal(applyFile(repoRoot, byPath['app.py']), 'from util import fetch_user\nvalue = fetch_user(1)\n')
})

test('renames a Rust function across files', () => {
    const repoRoot = fixtureRepo({
        'lib.rs': 'pub fn compute(n: i32) -> i32 {\n    n\n}\n',
        'main.rs': 'fn main() {\n    let r = compute(2);\n}\n',
    })
    const rawGraph = {
        nodes: [symNode('lib.rs#compute@1', 'compute'), symNode('main.rs#main@1', 'main')],
        links: [callLink('main.rs#main@1', 'lib.rs#compute@1', 2)],
    }
    const result = buildGraphRenamePlan({repoRoot, rawGraph, symbolId: 'lib.rs#compute@1', newName: 'calculate'})
    const byPath = Object.fromEntries(result.plan.files.map((file) => [file.path, file]))
    assert.equal(applyFile(repoRoot, byPath['lib.rs']), 'pub fn calculate(n: i32) -> i32 {\n    n\n}\n')
    assert.equal(applyFile(repoRoot, byPath['main.rs']), 'fn main() {\n    let r = calculate(2);\n}\n')
})

test('a reference line with two occurrences of the name is UNCERTAIN, never guessed', () => {
    const repoRoot = fixtureRepo({
        'a.go': 'func save(x int) int {\n    return x\n}\n',
        'b.go': 'func use() {\n    save(save(1))\n}\n',
    })
    const rawGraph = {
        nodes: [symNode('a.go#save@1', 'save'), symNode('b.go#use@1', 'use')],
        links: [callLink('b.go#use@1', 'a.go#save@1', 2)],
    }
    const result = buildGraphRenamePlan({repoRoot, rawGraph, symbolId: 'a.go#save@1', newName: 'persist'})
    assert.equal(result.status, 'PLANNED')
    assert.ok(result.plan.uncertainReferences.some((ref) => ref.reason === 'AMBIGUOUS_LINE_MULTIPLE_OCCURRENCES'))
    // only the declaration is edited; the ambiguous call line is left for review
    assert.deepEqual(result.plan.files.map((file) => file.path), ['a.go'])
})

test('a method that participates in inheritance warns to check overrides/impls', () => {
    const repoRoot = fixtureRepo({'Svc.java': 'class Svc {\n    void run() {}\n}\n'})
    const rawGraph = {
        nodes: [symNode('Svc.java#run@2', 'run')],
        links: [{source: 'Other.java#run@2', target: 'Svc.java#run@2', relation: 'overrides'}],
    }
    const result = buildGraphRenamePlan({repoRoot, rawGraph, symbolId: 'Svc.java#run@2', newName: 'execute'})
    assert.ok(result.plan.warnings.includes('POSSIBLE_OVERRIDE_OR_IMPLEMENTATION_RENAME_NEEDED'))
})

test('JS/TS and SQL are routed to their own backends', () => {
    const repoRoot = fixtureRepo({'a.ts': 'export const x = 1\n', 'q.sql': 'CREATE TABLE t (id INT);\n'})
    const rawGraph = {nodes: [symNode('a.ts#x@1', 'x'), {id: 'q.sql#t@1', source_file: 'q.sql', label: 't', symbol_kind: 'table'}], links: []}
    assert.equal(buildGraphRenamePlan({repoRoot, rawGraph, symbolId: 'a.ts#x@1', newName: 'y'}).status, 'USE_LSP_BACKEND')
    assert.equal(buildGraphRenamePlan({repoRoot, rawGraph, symbolId: 'q.sql#t@1', newName: 'u'}).status, 'USE_SQL_BACKEND')
})

test('expected failure modes are explicit statuses', () => {
    const repoRoot = fixtureRepo({'util.py': 'def get_user(x):\n    return x\n'})
    const rawGraph = {nodes: [symNode('util.py#get_user@1', 'get_user')], links: []}
    const call = (over) => buildGraphRenamePlan({repoRoot, rawGraph, symbolId: 'util.py#get_user@1', newName: 'fetch_user', ...over})
    assert.equal(call({symbolId: 'util.py'}).status, 'NOT_A_SYMBOL')
    assert.equal(call({symbolId: 'util.py#gone@9'}).status, 'NOT_FOUND')
    assert.equal(call({newName: '1bad'}).status, 'INVALID_NEW_NAME')
    assert.equal(call({newName: 'get_user'}).status, 'NO_CHANGE')
})
