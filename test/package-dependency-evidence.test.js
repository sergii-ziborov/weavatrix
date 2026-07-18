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

function withBunRepo(files, run) {
    const repo = mkdtempSync(join(tmpdir(), 'weavatrix-package-graph-bun-'))
    try {
        for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content)
        return run(repo)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
}

// JSONC on purpose: comments and trailing commas, exactly as bun >= 1.2 writes them.
const BUN_LOCK_FIXTURE = `// bun lockfile
{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "cidr-tools": "^12.1.2",
        "make-dir": "^3.0.2",
        "lib": "workspace:*",
      },
      "devDependencies": {
        "dev-only": "^1.0.0",
      },
    },
    "packages/lib": {
      "name": "lib",
      "dependencies": {
        "ip-bigint": "^9.0.6",
      },
    },
  },
  "packages": {
    "cidr-tools": ["cidr-tools@12.1.2", "", { "dependencies": { "ip-bigint": "^9.0.6" } }, "sha512-aaa"],
    "dev-only": ["dev-only@1.0.0", "", { "dependencies": { "dev-transitive": "^1.0.0", "semver": "^7.0.0" }, "peerDependencies": { "missing-peer": "*" }, "optionalPeers": ["missing-peer"] }, "sha512-bbb"],
    "dev-transitive": ["dev-transitive@1.0.0", "", {}, "sha512-ccc"],
    "ip-bigint": ["ip-bigint@9.0.6", "", {}, "sha512-ddd"],
    "lib": ["lib@workspace:packages/lib"],
    "make-dir": ["make-dir@3.1.0", "", { "dependencies": { "semver": "^6.0.0" } }, "sha512-eee"],
    "make-dir/semver": ["semver@6.3.1", "", {}, "sha512-fff"],
    "semver": ["semver@7.8.3", "", {}, "sha512-ggg"],
  },
}
`

test('package dependency evidence parses bun.lock with nested overrides, direct flags, and dev reachability', () =>
    withBunRepo({'bun.lock': BUN_LOCK_FIXTURE}, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.state, 'COMPLETE')
        assert.equal(graph.ecosystem, 'npm')
        assert.equal(graph.lockfile, 'bun.lock')
        assert.equal(graph.lockfileVersion, 1)
        assert.deepEqual(graph.completeness.reasons, [])
        assert.equal(graph.completeness.declarations.unresolved, 0)
        assert.equal(graph.completeness.declarations.optionalMissing, 1)
        assert.equal(graph.completeness.declarations.local, 1)

        // BFS-relevant naming: bare package names plus the same id shape as the npm parser.
        const byName = (name, version) => graph.nodes.find((node) => node.name === name && (!version || node.version === version))
        for (const node of graph.nodes) {
            assert.match(node.id, new RegExp(`^npm:${node.name.replace('/', '\\/')}@${node.version.replaceAll('.', '\\.')}:[a-f0-9]{12}$`))
        }
        assert.equal(graph.nodes.filter((node) => node.name === 'semver').length, 2)
        assert.equal(graph.nodes.some((node) => node.name === 'lib'), false)

        // Direct flags: root and workspace declarations only.
        assert.equal(byName('cidr-tools').direct, true)
        assert.equal(byName('make-dir').direct, true)
        assert.equal(byName('dev-only').direct, true)
        assert.equal(byName('ip-bigint').direct, true) // declared by the lib workspace
        assert.equal(byName('semver', '6.3.1').direct, false)
        assert.equal(byName('semver', '7.8.3').direct, false)

        // Dev reachability approximation: dev-only and its subtree are dev, runtime graph is not.
        assert.equal(byName('dev-only').dev, true)
        assert.equal(byName('dev-transitive').dev, true)
        assert.equal(byName('semver', '7.8.3').dev, true)
        assert.equal(byName('cidr-tools').dev, false)
        assert.equal(byName('semver', '6.3.1').dev, false)
        assert.equal(byName('ip-bigint').optional, false)
        assert.equal(byName('ip-bigint').peer, false)

        // Edges: root declarations plus transitive subtrees, honoring the nested override.
        const hasEdge = (from, to, kind) => graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)
        assert.ok(hasEdge('(root)', byName('cidr-tools').id, 'runtime'))
        assert.ok(hasEdge('(root)', byName('dev-only').id, 'dev'))
        assert.ok(hasEdge('(root)', byName('ip-bigint').id, 'runtime'))
        assert.ok(hasEdge(byName('cidr-tools').id, byName('ip-bigint').id, 'runtime'))
        assert.ok(hasEdge(byName('make-dir').id, byName('semver', '6.3.1').id, 'runtime'))
        assert.ok(hasEdge(byName('dev-only').id, byName('semver', '7.8.3').id, 'runtime'))
        assert.equal(hasEdge(byName('make-dir').id, byName('semver', '7.8.3').id, 'runtime'), false)
    }))

test('package dependency evidence keeps npm lockfiles ahead of bun.lock and reports malformed bun locks', () => {
    withBunRepo({
        'bun.lock': BUN_LOCK_FIXTURE,
        'package-lock.json': JSON.stringify({
            name: 'fixture', version: '1.0.0', lockfileVersion: 3,
            packages: {'': {dependencies: {a: '1.0.0'}}, 'node_modules/a': {version: '1.0.0'}},
        }),
    }, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.lockfile, 'package-lock.json')
        assert.equal(graph.nodes.length, 1)
        assert.equal(graph.nodes[0].name, 'a')
    })
    withBunRepo({'bun.lock': '{"lockfileVersion": 1}'}, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.state, 'PARTIAL')
        assert.deepEqual(graph.completeness.reasons, ['BUN_LOCK_PACKAGES_REQUIRED'])
    })
    withBunRepo({'bun.lock': '{not json at all'}, (repo) => {
        const graph = buildPackageDependencyGraph(repo)
        assert.equal(graph.state, 'ERROR')
        assert.deepEqual(graph.completeness.reasons, ['PACKAGE_LOCK_READ_ERROR'])
        assert.equal(JSON.stringify(graph).includes(repo), false)
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
