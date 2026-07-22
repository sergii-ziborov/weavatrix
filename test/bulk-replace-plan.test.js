import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildBulkReplacePlan} from '../src/analysis/bulk-replace-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-bulk-'))
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repoRoot, path, '..'), {recursive: true})
        writeFileSync(join(repoRoot, path), content)
    }
    return repoRoot
}

const graphFor = (...files) => ({nodes: files.map((file) => ({id: file, source_file: file})), links: [], graphRevision: 'test'})

test('stage 1 previews every occurrence with stable ids and no plan', () => {
    const repoRoot = fixtureRepo({
        'a.js': 'callApi("v1")\ncallApi("v1")\n',
        'b.js': 'const url = "v1"\n',
    })
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('a.js', 'b.js'), pattern: '"v1"', replacement: '"v2"'})
    assert.equal(result.status, 'PREVIEW')
    assert.equal(result.total, 3)
    assert.equal(result.occurrences[0].id, 'a.js@1:8')
    assert.equal(result.occurrences[1].id, 'a.js@2:8')
    assert.equal(result.plan, undefined)
})

test('stage 2 with occurrence_ids plans only the selection, per-file merged', () => {
    const repoRoot = fixtureRepo({
        'a.js': 'callApi("v1")\ncallApi("v1")\n',
        'b.js': 'const url = "v1"\n',
    })
    const rawGraph = graphFor('a.js', 'b.js')
    const preview = buildBulkReplacePlan({repoRoot, rawGraph, pattern: '"v1"', replacement: '"v2"'})
    const picked = [preview.occurrences[0].id, preview.occurrences[2].id]
    const result = buildBulkReplacePlan({repoRoot, rawGraph, pattern: '"v1"', replacement: '"v2"', occurrence_ids: picked})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.total, 2)
    assert.equal(result.plan.files.length, 2)
    assert.equal(result.plan.files[0].edits[0].provenance, 'LEXICAL_EXACT')
    assert.equal(result.plan.files[0].edits[0].before, '"v1"')
    assert.equal(result.plan.files[0].edits[0].after, '"v2"')
})

test('expected_count guards the plan-everything path and refuses on mismatch', () => {
    const repoRoot = fixtureRepo({'a.js': 'x = 1\nx = 1\n'})
    const rawGraph = graphFor('a.js')
    assert.equal(buildBulkReplacePlan({repoRoot, rawGraph, pattern: 'x = 1', replacement: 'x = 2', expected_count: 2}).status, 'PLANNED')
    const mismatch = buildBulkReplacePlan({repoRoot, rawGraph, pattern: 'x = 1', replacement: 'x = 2', expected_count: 5})
    assert.equal(mismatch.status, 'COUNT_MISMATCH')
})

test('unknown occurrence ids refuse the whole selection', () => {
    const repoRoot = fixtureRepo({'a.js': 'x = 1\n'})
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('a.js'), pattern: 'x = 1', replacement: 'y', occurrence_ids: ['a.js@1:0', 'a.js@99:0']})
    assert.equal(result.status, 'UNKNOWN_OCCURRENCES')
    assert.deepEqual(result.unknown, ['a.js@99:0'])
})

test('regex mode expands $1/$& against the actual match, lookbehind included', () => {
    const repoRoot = fixtureRepo({'a.js': 'const fooBar = 1\nconst bazBar = 2\n'})
    const result = buildBulkReplacePlan({
        repoRoot,
        rawGraph: graphFor('a.js'),
        pattern: '(?<=const )(\\w+)Bar',
        replacement: '$1Baz',
        literal: false,
        expected_count: 2,
    })
    assert.equal(result.status, 'PLANNED')
    assert.deepEqual(result.plan.files[0].edits.map((edit) => edit.after), ['fooBaz', 'bazBaz'])
    // the lookbehind is context, never part of the replaced range
    assert.deepEqual(result.plan.files[0].edits.map((edit) => edit.before), ['fooBar', 'bazBar'])
})

test('multi-line regex matches carry exact spanning ranges', () => {
    const repoRoot = fixtureRepo({'a.js': 'start(\n    old\n)\n'})
    const result = buildBulkReplacePlan({
        repoRoot,
        rawGraph: graphFor('a.js'),
        pattern: 'start\\([^)]*\\)',
        replacement: 'start(new)',
        literal: false,
        flags: 's',
        expected_count: 1,
    })
    assert.equal(result.status, 'PLANNED')
    const edit = result.plan.files[0].edits[0]
    assert.equal(edit.startLine, 1)
    assert.equal(edit.endLine, 3)
    assert.equal(edit.before, 'start(\n    old\n)')
})

test('binary and oversized files are skipped into notModified, never corrupted', () => {
    const repoRoot = fixtureRepo({'a.js': 'x = 1\n'})
    writeFileSync(join(repoRoot, 'bin.dat'), Buffer.from([0x00, 0xff, 0x78, 0x20, 0x3d, 0x20, 0x31]))
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('a.js', 'bin.dat'), pattern: 'x = 1', replacement: 'y', expected_count: 1})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.plan.notModified[0].path, 'bin.dat')
    assert.ok(result.plan.warnings.includes('FILES_SKIPPED'))
})

test('invalid patterns, flags and empty scans fail closed', () => {
    const repoRoot = fixtureRepo({'a.js': 'x\n'})
    const rawGraph = graphFor('a.js')
    assert.equal(buildBulkReplacePlan({repoRoot, rawGraph, pattern: '', replacement: 'y'}).status, 'INVALID_PATTERN')
    assert.equal(buildBulkReplacePlan({repoRoot, rawGraph, pattern: '(', replacement: 'y', literal: false}).status, 'INVALID_PATTERN')
    assert.equal(buildBulkReplacePlan({repoRoot, rawGraph, pattern: 'x', replacement: 'y', flags: 'g'}).status, 'INVALID_PATTERN')
    assert.equal(buildBulkReplacePlan({repoRoot, rawGraph, pattern: 'absent', replacement: 'y'}).status, 'NO_MATCHES')
})

test('path_prefix narrows the scanned universe and the limitation is always labeled', () => {
    const repoRoot = fixtureRepo({'src/a.js': 'x = 1\n', 'docs/b.js': 'x = 1\n'})
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('src/a.js', 'docs/b.js'), pattern: 'x = 1', replacement: 'y', path_prefix: 'src/', expected_count: 1})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.plan.files.length, 1)
    assert.ok(result.plan.warnings.includes('INDEXED_UNIVERSE_ONLY'))
})

test('path_prefix is segment-anchored: "src" never leaks into "src-evil/"', () => {
    const repoRoot = fixtureRepo({'src/a.js': 'x = 1\n', 'src-evil/b.js': 'x = 1\n'})
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('src/a.js', 'src-evil/b.js'), pattern: 'x = 1', replacement: 'y', path_prefix: 'src', expected_count: 1})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.plan.files.length, 1)
    assert.equal(result.plan.files[0].path, 'src/a.js')
})

test('two-digit and named group references expand against the real match, not $1+"0"', () => {
    const repoRoot = fixtureRepo({'a.js': 'ABCDEFGHIJ\n'})
    // ten capture groups; $10 must resolve to group 10 (J), not group 1 (A) + "0"
    const result = buildBulkReplacePlan({
        repoRoot,
        rawGraph: graphFor('a.js'),
        pattern: '(A)(B)(C)(D)(E)(F)(G)(H)(I)(J)',
        replacement: '$10$1',
        literal: false,
        expected_count: 1,
    })
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.plan.files[0].edits[0].after, 'JA')
})

test('named group substitution $<name> expands; a missing group stays literal', () => {
    const repoRoot = fixtureRepo({'a.js': 'user=42\n'})
    const result = buildBulkReplacePlan({
        repoRoot,
        rawGraph: graphFor('a.js'),
        pattern: '(?<key>\\w+)=(?<val>\\d+)',
        replacement: '$<val>:$<key> $9',
        literal: false,
        expected_count: 1,
    })
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.plan.files[0].edits[0].after, '42:user $9')
})

test('a pure zero-width pattern is ZERO_WIDTH_UNSUPPORTED, not a false NO_MATCHES', () => {
    const repoRoot = fixtureRepo({'a.js': 'v1 and v1\n'})
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('a.js'), pattern: '(?=v1)', replacement: 'X', literal: false})
    assert.equal(result.status, 'ZERO_WIDTH_UNSUPPORTED')
    assert.match(result.reason, /zero-width/)
})

test('an empty occurrence_ids selection fails closed as NO_SELECTION, never an empty plan', () => {
    const repoRoot = fixtureRepo({'a.js': 'x = 1\n'})
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('a.js'), pattern: 'x = 1', replacement: 'y', occurrence_ids: []})
    assert.equal(result.status, 'NO_SELECTION')
})

test('an indexed file that vanished since indexing is surfaced in skipped, not swallowed', () => {
    const repoRoot = fixtureRepo({'a.js': 'x = 1\n'})
    // b.js is in the graph but never written to disk
    const result = buildBulkReplacePlan({repoRoot, rawGraph: graphFor('a.js', 'b.js'), pattern: 'x = 1', replacement: 'y', expected_count: 1})
    assert.equal(result.status, 'PLANNED')
    assert.ok(result.plan.notModified.some((entry) => entry.path === 'b.js'))
    assert.ok(result.plan.warnings.includes('FILES_SKIPPED'))
})
