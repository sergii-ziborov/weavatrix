import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {buildPackageDependencyGraph} from '../src/mcp/evidence-snapshot.package-graph.mjs'

function withRepo(lock, run) {
    const repo = mkdtempSync(join(tmpdir(), 'weavatrix-package-graph-'))
    try {
        writeFileSync(join(repo, 'package-lock.json'), JSON.stringify(lock))
        return run(repo)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
}

test('package dependency evidence resolves nested npm v2 packages and skips workspace links', () => withRepo({
    name: 'fixture', version: '1.0.0', lockfileVersion: 2,
    packages: {
        '': {
            dependencies: {a: '1.0.0', local: '1.0.0'},
            optionalDependencies: {'platform-only': '1.0.0'},
        },
        'node_modules/a': {version: '1.0.0', dependencies: {b: '1.0.0'}},
        'node_modules/a/node_modules/b': {version: '1.0.0'},
        'node_modules/b': {version: '2.0.0'},
        'node_modules/local': {resolved: 'packages/local', link: true},
        'packages/local': {name: 'local', version: '1.0.0', dependencies: {b: '2.0.0'}},
    },
}, (repo) => {
    const graph = buildPackageDependencyGraph(repo)
    assert.equal(graph.state, 'COMPLETE')
    assert.equal(graph.lockfileVersion, 2)
    assert.equal(graph.completeness.declarations.local, 1)
    assert.equal(graph.completeness.declarations.unresolved, 0)
    assert.equal(graph.completeness.declarations.optionalMissing, 1)
    assert.equal(graph.nodes.filter((node) => node.name === 'b').length, 2)

    const a = graph.nodes.find((node) => node.name === 'a')
    const nestedB = graph.nodes.find((node) => node.name === 'b' && node.version === '1.0.0')
    const rootB = graph.nodes.find((node) => node.name === 'b' && node.version === '2.0.0')
    assert.ok(graph.edges.some((edge) => edge.from === a.id && edge.to === nestedB.id))
    assert.ok(graph.edges.some((edge) => edge.from === '(root)' && edge.to === rootB.id))
    assert.equal(graph.nodes.some((node) => node.name === 'local'), false)
}))

test('package dependency evidence is explicitly bounded while preserving direct packages first', () => {
    const dependencies = {}
    const packages = {'': {dependencies}}
    for (let index = 0; index < 5_005; index++) {
        const name = `package-${String(index).padStart(5, '0')}`
        dependencies[name] = '1.0.0'
        packages[`node_modules/${name}`] = {version: '1.0.0'}
    }
    return withRepo({name: 'large', version: '1.0.0', lockfileVersion: 3, packages}, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.state, 'PARTIAL')
        assert.deepEqual(graph.completeness.nodes, {total: 5_005, returned: 5_000, truncated: true})
        assert.equal(graph.completeness.edges.total, 5_005)
        assert.equal(graph.completeness.edges.returned, 5_000)
        assert.equal(graph.completeness.edges.truncated, true)
        assert.equal(graph.nodes.every((node) => node.direct), true)
        assert.ok(graph.completeness.reasons.includes('PACKAGE_NODE_LIMIT_REACHED'))
        assert.ok(graph.completeness.reasons.includes('PACKAGE_EDGE_LIMIT_REACHED'))
    })
})

test('package dependency evidence reports unsupported and malformed locks without leaking paths', () => {
    withRepo({lockfileVersion: 1, dependencies: {}}, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.state, 'PARTIAL')
        assert.deepEqual(graph.completeness.reasons, ['PACKAGE_LOCK_V2_V3_REQUIRED'])
    })
    withRepo({lockfileVersion: 3, packages: {'/': {dependencies: {evil: '1.0.0'}}}}, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.state, 'PARTIAL')
        assert.ok(graph.completeness.reasons.includes('INVALID_LOCKFILE_PACKAGE_RECORDS'))
        assert.equal(JSON.stringify(graph).includes(repo), false)
    })
    withRepo({lockfileVersion: 3, packages: {
        '': {dependencies: {evil: '1.0.0'}},
        'node_modules/evil': {version: 'https://attacker.invalid/payload'},
    }}, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.state, 'PARTIAL')
        assert.ok(graph.completeness.reasons.includes('INVALID_LOCKFILE_PACKAGE_VERSIONS'))
        assert.equal(graph.nodes.some((node) => node.name === 'evil'), false)
        assert.equal(JSON.stringify(graph).includes('attacker.invalid'), false)
    })
})
