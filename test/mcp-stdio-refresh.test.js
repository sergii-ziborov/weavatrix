import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {graphStorageKey} from '../src/graph/layout.js'
import {persistedFreshnessMatches, repositoryFreshnessProbe} from '../src/graph/freshness-probe.js'
import {startServer} from './helpers/mcp-stdio-fixture.js'

function git(repo, args) {
    const result = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8', windowsHide: true})
    assert.equal(result.status, 0, result.stderr || result.stdout)
}
test('persisted freshness skips the full snapshot after MCP restart and is replaced after a partial refresh', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-persisted-freshness-'))
    const repo = join(parent, 'repo')
    const graphHome = join(parent, 'graph-home')
    const graphDir = join(graphHome, graphStorageKey(repo))
    const graphPath = join(graphDir, 'graph.json')
    const source = join(repo, 'src', 'calculate.js')
    mkdirSync(dirname(source), {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'restart-fixture', version: '1.0.0', type: 'module'}))
    writeFileSync(source, 'export function calculate(value) { return value + 1 }\n')
    git(repo, ['init', '-q'])
    git(repo, ['add', '.'])
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'])

    const callStats = async (server, timeoutMs = 60_000) => {
        await server.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-test', version: '1.0.0'}})
        server.notify('notifications/initialized')
        return server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}}, timeoutMs)
    }

    try {
        const firstServer = startServer(graphPath, repo, graphHome)
        try {
            const first = await callStats(firstServer)
            assert.equal(first.structuredContent.graph.update, 'full')
        } finally { await firstServer.stop() }

        const firstRaw = JSON.parse(readFileSync(graphPath, 'utf8'))
        const firstProbe = repositoryFreshnessProbe(repo)
        assert.equal(persistedFreshnessMatches(firstRaw, firstProbe, 'full'), true)

        // A live canonical graph lock makes an accidental build path block. The restarted server must
        // answer through its persisted probe without touching the repository snapshot/build transaction.
        const lockDir = join(graphDir, '.graph.lock')
        mkdirSync(lockDir)
        writeFileSync(join(lockDir, 'owner'), `${process.pid}\n${new Date().toISOString()}\n`)
        const restarted = startServer(graphPath, repo, graphHome)
        try {
            // A rebuild would wait on the active lock for minutes. Completing inside the
            // request deadline proves that restart used the persisted freshness probe;
            // avoid a sub-second wall-clock margin that flakes under parallel CI load.
            const unchanged = await callStats(restarted, 10_000)
            assert.equal(unchanged.structuredContent.graph.update, 'none')
        } finally { await restarted.stop() }
        rmSync(lockDir, {recursive: true, force: true})

        // Same-size dirty edit across another process invalidates the stamp and takes the incremental
        // authority path. The refreshed graph persists the new exact dirty-content probe.
        writeFileSync(source, 'export function calculate(value) { return value + 2 }\n')
        const dirtyProbe = repositoryFreshnessProbe(repo)
        assert.notEqual(dirtyProbe, firstProbe)
        const dirtyServer = startServer(graphPath, repo, graphHome)
        try {
            const refreshed = await callStats(dirtyServer)
            assert.equal(refreshed.structuredContent.graph.update, 'incremental')
            assert.ok(refreshed.structuredContent.graph.changedFiles >= 1)
        } finally { await dirtyServer.stop() }
        const refreshedRaw = JSON.parse(readFileSync(graphPath, 'utf8'))
        assert.equal(persistedFreshnessMatches(refreshedRaw, dirtyProbe, 'full'), true)

        // A legacy graph safely performs one authoritative fallback and gains a restart stamp. This is
        // intentionally a metadata-only rewrite when source content itself is unchanged.
        for (const key of [
            'repositoryFreshnessProbeV',
            'repositoryFreshnessBuilderSchemaV',
            'repositoryFreshnessBuilderVersion',
            'repositoryFreshnessProbe',
            'repositoryFreshnessMode',
        ]) delete refreshedRaw[key]
        writeFileSync(graphPath, JSON.stringify(refreshedRaw))
        const legacyServer = startServer(graphPath, repo, graphHome)
        try {
            const migrated = await callStats(legacyServer)
            assert.equal(migrated.structuredContent.graph.update, 'none')
        } finally { await legacyServer.stop() }
        const migratedRaw = JSON.parse(readFileSync(graphPath, 'utf8'))
        assert.equal(persistedFreshnessMatches(migratedRaw, dirtyProbe, 'full'), true)
    } finally { rmSync(parent, {recursive: true, force: true}) }
})

test('MCP auto-refresh preserves an active no-tests graph mode', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-no-tests-'))
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'classic-graph-output', 'graph.json')
    mkdirSync(join(repo, 'src'), {recursive: true})
    mkdirSync(join(repo, 'test-e2e', 'cypress'), {recursive: true})
    writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
    writeFileSync(join(repo, 'test-e2e', 'cypress', 'app.cy.js'), "import { app } from '../../src/app.js'\nconsole.log(app)\n")

    const server = startServer(graphPath, repo, join(parent, 'graph-home'))
    try {
        await server.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-test', version: '1.0.0'}})
        server.notify('notifications/initialized')
        const rebuilt = await server.request('tools/call', {name: 'rebuild_graph', arguments: {mode: 'no-tests', precision: 'off'}})
        assert.equal(rebuilt.isError, undefined, server.stderr())
        const preserved = await server.request('tools/call', {name: 'rebuild_graph', arguments: {}})
        assert.equal(preserved.isError, undefined, server.stderr())
        const stats = await server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}})
        assert.equal(stats.isError, undefined, server.stderr())
        assert.equal(stats.structuredContent.graph.update, 'none')
        const saved = JSON.parse(readFileSync(graphPath, 'utf8'))
        assert.equal(saved.graphBuildMode, 'no-tests')
        assert.equal(saved.graphPrecisionMode, 'off')
        assert.equal(saved.nodes.some((node) => String(node.source_file).startsWith('test-e2e/')), false)
    } finally {
        await server.stop()
        rmSync(parent, {recursive: true, force: true})
    }
})

test('MCP no-tests refreshes membership when .weavatrix.json classification changes', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-classification-'))
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'classic-graph-output', 'graph.json')
    mkdirSync(join(repo, 'src'), {recursive: true})
    mkdirSync(join(repo, 'quality'), {recursive: true})
    writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
    writeFileSync(join(repo, 'quality', 'probe.js'), 'export const probe = 1\n')
    writeFileSync(join(repo, '.weavatrix.json'), JSON.stringify({classify: {test: ['quality/**']}}))
    const server = startServer(graphPath, repo, join(parent, 'graph-home'))
    try {
        await server.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-test', version: '1.0.0'}})
        server.notify('notifications/initialized')
        await server.request('tools/call', {name: 'rebuild_graph', arguments: {mode: 'no-tests'}})
        let saved = JSON.parse(readFileSync(graphPath, 'utf8'))
        assert.equal(saved.nodes.some((node) => node.source_file === 'quality/probe.js'), false)
        writeFileSync(join(repo, '.weavatrix.json'), JSON.stringify({classify: {test: []}}))
        const stats = await server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}})
        assert.equal(stats.structuredContent.graph.update, 'full')
        saved = JSON.parse(readFileSync(graphPath, 'utf8'))
        assert.equal(saved.graphBuildMode, 'no-tests')
        assert.equal(saved.nodes.some((node) => node.source_file === 'quality/probe.js'), true)
    } finally {
        await server.stop()
        rmSync(parent, {recursive: true, force: true})
    }
})

test('list_endpoints refreshes the graph before discovering a newly added route file', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-endpoints-'))
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'classic-graph-output', 'graph.json')
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'endpoint-fixture', version: '1.0.0'}))
    writeFileSync(join(repo, 'src', 'app.js'), 'export const app = {}\n')
    const server = startServer(graphPath, repo, join(parent, 'graph-home'))
    try {
        await server.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-test', version: '1.0.0'}})
        server.notify('notifications/initialized')
        await server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}})
        writeFileSync(join(repo, 'src', 'routes.js'), "router.get('/api/live', liveHandler)\n")
        const endpoints = await server.request('tools/call', {name: 'list_endpoints', arguments: {max_results: 20}})
        assert.equal(endpoints.isError, undefined, server.stderr())
        assert.match(endpoints.content[0].text, /GET\s+\/api\/live/)
    } finally {
        await server.stop()
        rmSync(parent, {recursive: true, force: true})
    }
})
