import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createEvidenceSnapshot} from '../src/mcp/evidence-snapshot.mjs'
import {sanitizeFinding} from '../src/mcp/evidence-snapshot.common.mjs'

function fixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'weavatrix-evidence-'))
    mkdirSync(join(repo, 'src', 'api'), {recursive: true})
    mkdirSync(join(repo, 'src', 'ui'), {recursive: true})
    mkdirSync(join(repo, 'src', 'shared'), {recursive: true})
    writeFileSync(join(repo, 'src', 'api', 'a.js'), 'export const a = () => 1\n')
    writeFileSync(join(repo, 'src', 'ui', 'b.js'), 'export const b = () => 2\n')
    writeFileSync(join(repo, 'src', 'shared', 'c.js'), 'export const c = () => 3\n')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'fixture', version: '1.0.0', dependencies: {'left-pad': '1.3.0'}}))
    writeFileSync(join(repo, '.weavatrix-deps.json'), JSON.stringify({
        forbidden: [{name: 'api-to-ui', severity: 'high', from: 'src/api/**', to: 'src/ui/**'}],
    }))
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({
        name: 'fixture', version: '1.0.0', lockfileVersion: 3,
        packages: {
            '': {name: 'fixture', version: '1.0.0'},
            'node_modules/left-pad': {version: '1.3.0'},
        },
    }))
    return repo
}

function fixtureGraph(secret) {
    const nodes = [
        {id: 'src/api/a.js', file_type: 'code', source_file: 'src/api/a.js'},
        {id: 'src/api/a.js#a@1', label: 'a()', file_type: 'code', source_file: 'src/api/a.js', source_text: secret,
            complexity: {startLine: 1, endLine: 350, loc: 350, cyclomatic: 35, params: 11, evidence: [secret]}},
        {id: 'src/ui/b.js', file_type: 'code', source_file: 'src/ui/b.js'},
        {id: 'src/ui/b.js#b@1', label: 'b()', file_type: 'code', source_file: 'src/ui/b.js', complexity: {loc: 20, cyclomatic: 2, params: 0}},
        {id: 'src/shared/c.js', file_type: 'code', source_file: 'src/shared/c.js'},
        {id: 'src/shared/c.js#c@1', label: 'x=C:\\Users\\Alice\\private.txt', file_type: 'code', source_file: 'src/shared/c.js',
            complexity: {loc: 301, cyclomatic: 2, params: 0}},
        {id: 'C:/Users/Alice/private.js#leak@1', label: secret, file_type: 'code', source_file: 'C:/Users/Alice/private.js', source_text: secret,
            complexity: {loc: 999, cyclomatic: 99, params: 99}},
    ]
    const links = [
        {source: 'src/api/a.js', target: 'src/api/a.js#a@1', relation: 'contains'},
        {source: 'src/ui/b.js', target: 'src/ui/b.js#b@1', relation: 'contains'},
        {source: 'src/api/a.js', target: 'src/ui/b.js', relation: 'imports'},
        {source: 'src/ui/b.js', target: 'src/api/a.js', relation: 'imports'},
        {source: 'src/ui/b.js', target: 'src/shared/c.js', relation: 'imports', typeOnly: true},
        {source: 'src/shared/c.js', target: 'src/api/a.js', relation: 'imports', compileOnly: true},
        {source: '/home/alice/private.js', target: 'src/api/a.js', relation: 'imports', source_text: secret},
    ]
    const externalImports = [
        {file: 'src/api/a.js', spec: 'left-pad', pkg: 'left-pad', ecosystem: 'npm', kind: 'esm', line: 1, source_text: secret},
        {file: 'src/ui/b.js', spec: 'left-pad', pkg: 'left-pad', ecosystem: 'npm', kind: 'esm', line: 1},
        {file: 'C:/Users/Alice/private.js', spec: 'private-package', pkg: 'private-package', ecosystem: 'npm', kind: 'esm', source_text: secret},
    ]
    return {repoBoundaryV: 1, edgeTypesV: 2, complexityV: 1, nodes, links, externalImports, injectedSource: secret}
}

test('evidence snapshot is canonical across shuffled graph arrays and separates edge classes', async () => {
    const repo = fixtureRepo()
    const secret = 'PRIVATE_SOURCE_BODY_9f4c'
    try {
        const graph = fixtureGraph(secret)
        const shuffled = {
            ...graph,
            nodes: [...graph.nodes].reverse(),
            links: [...graph.links].reverse(),
            externalImports: [...graph.externalImports].reverse(),
        }
        const first = await createEvidenceSnapshot({repoRoot: repo, graph})
        const second = await createEvidenceSnapshot({repoRoot: repo, graph: shuffled})
        assert.deepEqual(second, first)
        assert.match(first.snapshotHash, /^[a-f0-9]{64}$/)

        assert.deepEqual(first.sections.architecture.dependencies.runtime, [
            {from: 'src/api', to: 'src/ui', count: 1},
            {from: 'src/ui', to: 'src/api', count: 1},
        ])
        assert.deepEqual(first.sections.architecture.dependencies.typeOnly, [
            {from: 'src/ui', to: 'src/shared', count: 1},
        ])
        assert.deepEqual(first.sections.architecture.dependencies.compileOnly, [
            {from: 'src/shared', to: 'src/api', count: 1},
        ])
        assert.deepEqual(first.sections.architecture.cycles.map(({kind, members}) => ({kind, members})), [
            {kind: 'runtime', members: ['src/api/a.js', 'src/ui/b.js']},
            {kind: 'compile-time', members: ['src/api/a.js', 'src/shared/c.js', 'src/ui/b.js']},
        ])
        assert.deepEqual(first.sections.architecture.boundaryViolations, [{
            kind: 'forbidden', ruleId: 'api-to-ui', severity: 'high',
            from: 'src/api/a.js', to: 'src/ui/b.js',
        }])
        assert.deepEqual(first.sections.health.complexity.hotspots[0].breaches, [
            'CYCLOMATIC_HIGH', 'LOC_HIGH', 'PARAMS_HIGH',
        ])
        assert.equal(first.sections.health.complexity.hotspots[0].file, 'src/api/a.js')
        assert.deepEqual(first.sections.packages.directUsage, [{
            name: 'left-pad', ecosystem: 'npm', importCount: 2, fileCount: 2,
            files: ['src/api/a.js', 'src/ui/b.js'], filesTruncated: false, kinds: ['esm'],
        }])
        assert.ok(first.sections.packages.inventory.some((entry) =>
            entry.name === 'left-pad' && entry.version === '1.3.0' && entry.source === 'package-lock'))
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('evidence snapshot preserves unknown checks and never emits source text, snippets, titles, or absolute paths', async () => {
    const repo = fixtureRepo()
    const secret = 'PRIVATE_SOURCE_BODY_9f4c'
    try {
        const snapshot = await createEvidenceSnapshot({repoRoot: repo, graph: fixtureGraph(secret)})
        assert.equal(snapshot.sections.health.checks.osv, 'NOT_CHECKED')
        assert.equal(snapshot.sections.packages.checks.osv, 'NOT_CHECKED')
        assert.equal(snapshot.sections.health.state, 'PARTIAL')
        assert.notEqual(snapshot.sections.health.verdict, 'PASS')
        assert.notEqual(snapshot.sections.packages.verdict, 'PASS')
        for (const finding of snapshot.sections.health.findings) {
            assert.equal(Object.hasOwn(finding, 'title'), false)
            assert.equal(Object.hasOwn(finding, 'detail'), false)
            assert.equal(Object.hasOwn(finding, 'fixHint'), false)
            assert.equal(Object.hasOwn(finding, 'evidence'), false)
        }

        const wire = JSON.stringify(snapshot)
        assert.equal(wire.includes(secret), false)
        assert.equal(wire.includes(repo.replace(/\\/g, '/')), false)
        assert.equal(wire.includes('C:/Users/Alice'), false)
        assert.equal(wire.includes('/home/alice'), false)
        assert.equal(wire.includes('source_text'), false)
        assert.equal(wire.includes('snippet'), false)
        assert.equal(wire.includes('C:/Users/Alice'), false)
        assert.equal(wire.includes('fixHint'), false)
        assert.equal(wire.includes('detail'), false)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('finding evidence drops path-shaped symbol text', () => {
    const finding = sanitizeFinding({
        id: 'a'.repeat(16), category: 'unused', rule: 'unused-export', severity: 'low',
        file: 'src/a.js', symbol: 'x=/home/alice/.ssh/id_rsa',
    })
    assert.equal(finding.symbol, undefined)
})
