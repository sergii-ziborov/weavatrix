import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {graphStorageKey} from '../src/graph/layout.js'
import {persistedFreshnessMatches, repositoryFreshnessProbe} from '../src/graph/freshness-probe.js'

const SERVER = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))
const PROJECT_ROOT = dirname(dirname(SERVER))

function startServer(graphPath, repoRoot, graphHome) {
    const child = spawn(process.execPath, [SERVER, graphPath, repoRoot], {
        cwd: PROJECT_ROOT,
        env: {...process.env, WEAVATRIX_GRAPH_HOME: graphHome, WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS: '0'},
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let nextId = 1
    const pending = new Map()

    const failPending = (error) => {
        for (const {reject, timer} of pending.values()) {
            clearTimeout(timer)
            reject(error)
        }
        pending.clear()
    }
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000) })
    child.stdout.on('data', (chunk) => {
        stdout += chunk
        let newline
        while ((newline = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, newline).trim()
            stdout = stdout.slice(newline + 1)
            if (!line) continue
            let message
            try { message = JSON.parse(line) } catch { continue }
            if (message.id == null || !pending.has(message.id)) continue
            const entry = pending.get(message.id)
            pending.delete(message.id)
            clearTimeout(entry.timer)
            if (message.error) entry.reject(new Error(message.error.message || 'MCP request failed'))
            else entry.resolve(message.result)
        }
    })
    child.once('error', (error) => failPending(error))
    child.once('exit', (code, signal) => {
        failPending(new Error(`MCP server exited before replying (code=${code}, signal=${signal})\n${stderr}`))
    })

    const request = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`MCP request timed out: ${method}\n${stderr}`))
        }, timeoutMs)
        pending.set(id, {resolve, reject, timer})
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`)
    })
    const notify = (method, params = {}) => {
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method, params})}\n`)
    }
    const stop = async () => {
        if (child.exitCode != null || child.signalCode != null) return
        child.stdin.end()
        await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            new Promise((resolve) => setTimeout(resolve, 1_000)),
        ])
        if (child.exitCode == null && child.signalCode == null) child.kill()
        if (child.exitCode == null && child.signalCode == null) {
            await Promise.race([
                new Promise((resolve) => child.once('exit', resolve)),
                new Promise((resolve) => setTimeout(resolve, 1_000)),
            ])
        }
    }
    return {request, notify, stop, stderr: () => stderr}
}

function git(repo, args) {
    const result = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8', windowsHide: true})
    assert.equal(result.status, 0, result.stderr)
}

test('MCP stdio graph_stats owns the full -> incremental -> none graph lifecycle', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-lifecycle-'))
    const repo = join(parent, 'repo')
    const source = join(repo, 'src', 'calculate.js')
    const graphPath = join(parent, 'classic-graph-output', 'graph.json')
    mkdirSync(dirname(source), {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'lifecycle-fixture', version: '1.0.0', type: 'module'}))
    writeFileSync(source, 'export function calculate(value) {\n  return value + 1\n}\n')
    assert.equal(existsSync(graphPath), false)

    const server = startServer(graphPath, repo, join(parent, 'graph-home'))
    try {
        const initialized = await server.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {name: 'weavatrix-test', version: '1.0.0'},
        })
        assert.equal(initialized.serverInfo.name, 'weavatrix')
        server.notify('notifications/initialized')

        const stats = async () => server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}})
        const first = await stats()
        assert.equal(first.isError, undefined, server.stderr())
        assert.equal(first.structuredContent.graph.update, 'full')
        assert.equal(first.structuredContent.graph.changedFiles, 0)
        assert.equal(existsSync(graphPath), true, 'cold graph_stats must create the explicit classic graph path')

        writeFileSync(source, 'export function calculate(value) {\n  return value + 2\n}\n')
        const second = await stats()
        assert.equal(second.isError, undefined, server.stderr())
        assert.equal(second.structuredContent.graph.update, 'incremental')
        assert.ok(second.structuredContent.graph.changedFiles >= 1)
        const refreshedMtime = statSync(graphPath).mtimeMs

        const third = await stats()
        assert.equal(third.isError, undefined, server.stderr())
        assert.equal(third.structuredContent.graph.update, 'none')
        assert.equal(third.structuredContent.graph.changedFiles, 0)
        assert.equal(statSync(graphPath).mtimeMs, refreshedMtime, 'a no-op refresh must not rewrite graph.json')

        const compact = await server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'text'}})
        assert.equal(compact.structuredContent, undefined, 'text mode must not attach a duplicate structured payload')
        assert.match(compact.content[0].text, /^Repository: repo\n/)
    } finally {
        await server.stop()
        rmSync(parent, {recursive: true, force: true})
    }
})

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
            const startedAt = Date.now()
            const unchanged = await callStats(restarted, 3_000)
            assert.equal(unchanged.structuredContent.graph.update, 'none')
            assert.ok(Date.now() - startedAt < 2_900, 'persisted-probe restart must not wait for the graph lock')
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
        const rebuilt = await server.request('tools/call', {name: 'rebuild_graph', arguments: {mode: 'no-tests'}})
        assert.equal(rebuilt.isError, undefined, server.stderr())
        const stats = await server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}})
        assert.equal(stats.isError, undefined, server.stderr())
        assert.equal(stats.structuredContent.graph.update, 'none')
        const saved = JSON.parse(readFileSync(graphPath, 'utf8'))
        assert.equal(saved.graphBuildMode, 'no-tests')
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
