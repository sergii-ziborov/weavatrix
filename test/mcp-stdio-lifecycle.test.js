import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {PRECISION_OVERLAY_V} from '../src/precision/lsp-overlay.js'
import {MCP_SERVER as SERVER, PROJECT_ROOT, startServer} from './helpers/mcp-stdio-fixture.js'

test('MCP stdio identifies its runtime profile and exact registered catalog', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-runtime-profile-'))
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'graph', 'graph.json')
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'src', 'main.js'), 'export const value = 1\n')
    const server = startServer(graphPath, repo, join(parent, 'graph-home'), {WEAVATRIX_PRECISION: 'off'}, 'offline')
    try {
        const initialized = await server.request('initialize', {
            protocolVersion: '2024-11-05', capabilities: {},
            clientInfo: {name: 'weavatrix-test', version: '1.0.0'},
        })
        assert.match(initialized.instructions, new RegExp(`^Weavatrix ${initialized.serverInfo.version}; diskVersion=${initialized.serverInfo.version}; profile=offline; tools=34;`))
        const listed = await server.request('tools/list')
        assert.equal(listed.tools.length, 34)
        assert.deepEqual(listed._meta['weavatrix/runtime'], {
            version: initialized.serverInfo.version,
            diskVersion: initialized.serverInfo.version,
            staleRuntime: false,
            staleRuntimeAllowed: false,
            profile: 'offline',
            capabilities: ['graph', 'search', 'source', 'health', 'build', 'retarget', 'crossrepo'],
            toolCount: 34,
        })
        for (const name of ['trace_endpoint', 'trace_api_contract']) {
            assert.ok(listed.tools.some((tool) => tool.name === name), name)
        }
        const stats = await server.request('tools/call', {name: 'graph_stats', arguments: {}}, 90_000)
        assert.match(stats.content[0].text, /stale no; profile offline; 34 registered tools/)
    } finally {
        await server.stop()
        rmSync(parent, {recursive: true, force: true})
    }
})

test('MCP stdio fails loudly when package.json changes under a running process', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(PROJECT_ROOT, '.mcp-stale-runtime-'))
    const stagedSrc = join(parent, 'src')
    const stagedServer = join(stagedSrc, 'mcp-server.mjs')
    const stagedPackage = join(parent, 'package.json')
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'graph', 'graph.json')
    const currentPackage = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
    cpSync(join(PROJECT_ROOT, 'src'), stagedSrc, {recursive: true})
    writeFileSync(stagedPackage, JSON.stringify({name: 'weavatrix-stale-fixture', version: currentPackage.version, type: 'module'}))
    mkdirSync(repo, {recursive: true})
    const server = startServer(graphPath, repo, join(parent, 'graph-home'), {WEAVATRIX_PRECISION: 'off'}, 'offline', stagedServer)
    try {
        await server.request('ping')
        writeFileSync(stagedPackage, JSON.stringify({name: 'weavatrix-stale-fixture', version: '99.0.0', type: 'module'}))
        const initialize = {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'stale-test', version: '1'}}
        await assert.rejects(server.request('initialize', initialize), /STALE_RUNTIME: running Weavatrix .* package\.json on disk is 99\.0\.0/)
        await assert.rejects(server.request('tools/list'), /STALE_RUNTIME/)
        await assert.rejects(server.request('tools/call', {name: 'graph_stats', arguments: {}}), /STALE_RUNTIME/)
    } finally { await server.stop() }

    writeFileSync(stagedPackage, JSON.stringify({name: 'weavatrix-stale-fixture', version: currentPackage.version, type: 'module'}))
    const override = startServer(graphPath, repo, join(parent, 'override-graph-home'), {
        WEAVATRIX_PRECISION: 'off', WEAVATRIX_ALLOW_STALE_RUNTIME: '1',
    }, 'offline', stagedServer)
    try {
        await override.request('ping')
        writeFileSync(stagedPackage, JSON.stringify({name: 'weavatrix-stale-fixture', version: '99.0.0', type: 'module'}))
        const initialized = await override.request('initialize', {
            protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'stale-test', version: '1'},
        })
        assert.equal(initialized._meta['weavatrix/runtime'].diskVersion, '99.0.0')
        assert.equal(initialized._meta['weavatrix/runtime'].staleRuntime, true)
        assert.equal(initialized._meta['weavatrix/runtime'].staleRuntimeAllowed, true)
        assert.match(initialized.instructions, /Development override is active/)
        const listed = await override.request('tools/list')
        assert.equal(listed.tools.length, 34)
        assert.equal(listed._meta['weavatrix/runtime'].staleRuntime, true)
    } finally {
        await override.stop()
        rmSync(parent, {recursive: true, force: true})
    }
})

test('MCP startup precision setting applies before the first build and legacy overlays refresh strictly', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-precision-default-'))
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'classic-graph-output', 'graph.json')
    const precisionPath = join(dirname(graphPath), 'precision.json')
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({compilerOptions: {target: 'ES2022'}, include: ['src/**/*.ts']}))
    writeFileSync(join(repo, 'src', 'main.ts'), 'function helper() { return 1 }\nexport function run() { return helper() }\n')

    try {
        const parserOnly = startServer(graphPath, repo, join(parent, 'graph-home'), {WEAVATRIX_PRECISION: 'off'})
        try {
            await parserOnly.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-test', version: '1.0.0'}})
            parserOnly.notify('notifications/initialized')
            const stats = await parserOnly.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}})
            assert.equal(stats.isError, undefined, parserOnly.stderr())
            assert.equal(stats._meta['weavatrix/metrics'].schemaVersion, 'weavatrix.metrics.v1')
            assert.ok(stats._meta['weavatrix/metrics'].durationMs >= 0)
            assert.ok(stats._meta['weavatrix/metrics'].estimatedOutputTokens > 0)
            assert.equal(stats._meta['weavatrix/metrics'].graphFreshness, 'fresh')
            const saved = JSON.parse(readFileSync(graphPath, 'utf8'))
            assert.equal(saved.graphPrecisionMode, 'off')
            assert.equal(existsSync(precisionPath), true, 'OFF sidecar records the explicit parser-only state')
            assert.equal(JSON.parse(readFileSync(precisionPath, 'utf8')).state, 'OFF')
        } finally { await parserOnly.stop() }

        const legacy = JSON.parse(readFileSync(graphPath, 'utf8'))
        legacy.graphPrecisionMode = 'lsp'
        legacy.precisionOverlayV = 1
        writeFileSync(graphPath, JSON.stringify(legacy))
        rmSync(precisionPath, {force: true})

        const upgraded = startServer(graphPath, repo, join(parent, 'graph-home'))
        try {
            await upgraded.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-test', version: '1.0.0'}})
            upgraded.notify('notifications/initialized')
            const stats = await upgraded.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}}, 90_000)
            assert.equal(stats.isError, undefined, upgraded.stderr())
            const overlay = JSON.parse(readFileSync(precisionPath, 'utf8'))
            assert.equal(overlay.precisionOverlayV, PRECISION_OVERLAY_V)
            assert.notEqual(overlay.state, 'OFF')
        } finally { await upgraded.stop() }
    } finally { rmSync(parent, {recursive: true, force: true}) }
})

test('MCP refresh invalidates exact evidence when an ignored TypeScript config changes', {timeout: 120_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-semantic-input-'))
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'classic-graph-output', 'graph.json')
    const precisionPath = join(dirname(graphPath), 'precision.json')
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, '.gitignore'), 'tsconfig.json\n')
    writeFileSync(join(repo, 'src', 'target.ts'), 'function orphan() { return 1 }\n')
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({include: ['src/**/*.ts']}))
    git(repo, ['init', '-q'])
    git(repo, ['add', '.'])
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'])

    const server = startServer(graphPath, repo, join(parent, 'graph-home'), {WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS: '5000'})
    try {
        await server.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-test', version: '1.0.0'}})
        server.notify('notifications/initialized')
        let stats = await server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}}, 90_000)
        assert.equal(stats.isError, undefined, server.stderr())
        const first = JSON.parse(readFileSync(precisionPath, 'utf8'))
        assert.equal(first.state, 'COMPLETE')
        assert.match(first.semanticInputFingerprint, /^[a-f0-9]{64}$/)

        // Git status and the static graph revision stay unchanged because tsconfig is ignored. The
        // semantic fingerprint must still force a precision refresh before this graph answer.
        writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {plugins: [{name: 'evil-plugin'}]},
            include: ['src/**/*.ts'],
        }))
        stats = await server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}}, 90_000)
        assert.equal(stats.isError, undefined, server.stderr())
        const refreshed = JSON.parse(readFileSync(precisionPath, 'utf8'))
        assert.equal(refreshed.state, 'COMPLETE')
        assert.notEqual(refreshed.semanticInputFingerprint, first.semanticInputFingerprint)
        assert.equal(refreshed.pluginPolicy.configuredPluginsSuppressed, 1)
        assert.equal(refreshed.pluginPolicy.repoLocalPluginLoads, false)
    } finally {
        await server.stop()
        rmSync(parent, {recursive: true, force: true})
    }
})

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

test('MCP EOF drains an in-flight precision refresh and tolerates a closed stdout pipe', {timeout: 30_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-mcp-disconnect-'))
    const repo = join(parent, 'repo')
    const graphPath = join(parent, 'classic-graph-output', 'graph.json')
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'disconnect-fixture', private: true, type: 'module'}))
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({compilerOptions: {module: 'NodeNext', moduleResolution: 'NodeNext', strict: true}}))
    const imports = []
    const calls = []
    for (let index = 0; index < 64; index++) {
        writeFileSync(join(repo, 'src', `operation-${index}.ts`), `export function operation${index}(value: number) { return value + ${index} }\n`)
        imports.push(`import {operation${index}} from './operation-${index}.js'`)
        calls.push(`operation${index}(${index})`)
    }
    writeFileSync(join(repo, 'src', 'main.ts'), `${imports.join('\n')}\nexport const results = [${calls.join(', ')}]\n`)

    const server = startServer(graphPath, repo, join(parent, 'graph-home'))
    let pendingRefresh
    try {
        await server.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {name: 'weavatrix-disconnect-test', version: '1.0.0'},
        })
        server.notify('notifications/initialized')
        pendingRefresh = server.request('tools/call', {name: 'graph_stats', arguments: {output_format: 'json'}})
            .then(() => null, () => null)
        await new Promise((resolve) => setTimeout(resolve, 100))
        server.endInput()
        // Simulate the client disappearing completely. A late tool reply must not turn EPIPE into an
        // uncaught exception that skips semantic-provider cleanup.
        server.closeOutput()
        const exited = await server.waitForExit(12_000)
        await pendingRefresh
        assert.equal(exited.code, 0, server.stderr())
        assert.match(server.stderr(), /shutdown requested \((?:stdin EOF|stdout disconnected)\)/)
        assert.match(server.stderr(), /shutdown cleanup: graph=(?:drained|bounded-timeout), semantic=\d+ requested\/0 remaining/)
    } finally {
        await pendingRefresh
        await server.stop()
        // On Windows an orphaned TLS/tsserver tree retains this cwd long enough for recursive removal
        // to fail. Retried deletion turns that process leak into a deterministic regression signal.
        rmSync(parent, {recursive: true, force: true, maxRetries: 20, retryDelay: 50})
    }
})
