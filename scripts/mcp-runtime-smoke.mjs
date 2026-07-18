import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const FULL_TOOLS = Object.freeze([
    'change_impact', 'context_bundle', 'coverage_map', 'explain_architecture_violation',
    'find_dead_code', 'find_duplicates', 'get_architecture_contract', 'get_community',
    'get_dependents', 'get_neighbors', 'get_node', 'git_history', 'god_nodes', 'graph_diff',
    'graph_stats', 'hot_path_review', 'inspect_symbol', 'list_communities', 'list_endpoints',
    'list_known_repos', 'module_map', 'open_repo', 'prepare_change', 'preview_sync',
    'propose_architecture_exception', 'pull_architecture_contract', 'query_graph', 'read_source',
    'rebuild_graph', 'refresh_advisories', 'run_audit', 'search_code', 'shortest_path',
    'sync_graph', 'trace_api_contract', 'trace_endpoint', 'verified_change', 'verify_architecture',
].sort())

// These are intentionally absent from the default offline profile. preview_sync itself is local-only,
// but it is meaningful only as the first step of the explicitly selected hosted sync workflow.
const HOSTED_PROFILE_TOOLS = Object.freeze([
    'preview_sync', 'pull_architecture_contract', 'refresh_advisories', 'sync_graph',
])
const OFFLINE_TOOLS = Object.freeze(FULL_TOOLS.filter((name) => !HOSTED_PROFILE_TOOLS.includes(name)))

function runtime(entryPoint, repoRoot, profile, graphHome) {
    const child = spawn(process.execPath, [entryPoint, repoRoot, profile], {
        cwd: dirname(entryPoint),
        env: {
            ...process.env,
            WEAVATRIX_GRAPH_HOME: graphHome,
            WEAVATRIX_PRECISION: 'off',
            WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let nextId = 1
    let exitResult = null
    const pending = new Map()
    const exited = new Promise((resolveExited) => child.once('exit', (code, signal) => {
        exitResult = {code, signal}
        resolveExited(exitResult)
        const error = new Error(`MCP runtime exited before replying (code=${code}, signal=${signal})\n${stderr}`)
        for (const {reject, timer} of pending.values()) {
            clearTimeout(timer)
            reject(error)
        }
        pending.clear()
    }))
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000) })
    child.stdout.on('data', (chunk) => {
        stdout += chunk
        let newline
        while ((newline = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, newline).trim()
            stdout = stdout.slice(newline + 1)
            if (!line) continue
            let message
            try { message = JSON.parse(line) } catch { continue }
            const waiting = pending.get(message.id)
            if (!waiting) continue
            pending.delete(message.id)
            clearTimeout(waiting.timer)
            if (message.error) waiting.reject(new Error(message.error.message || 'MCP request failed'))
            else waiting.resolve(message.result)
        }
    })
    child.once('error', (error) => {
        for (const {reject, timer} of pending.values()) {
            clearTimeout(timer)
            reject(error)
        }
        pending.clear()
    })

    const request = (method, params = {}, timeoutMs = 90_000) => new Promise((resolveRequest, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`MCP request timed out: ${method}\n${stderr}`))
        }, timeoutMs)
        pending.set(id, {resolve: resolveRequest, reject, timer})
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`)
    })
    const stop = async () => {
        if (exitResult) return exitResult
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
        let timer
        try {
            return await Promise.race([
                exited,
                new Promise((resolveTimeout) => {
                    timer = setTimeout(() => {
                        child.kill()
                        resolveTimeout({code: child.exitCode, signal: child.signalCode || 'SIGTERM'})
                    }, 8_000)
                }),
            ])
        } finally { if (timer) clearTimeout(timer) }
    }
    return {request, stop, stderr: () => stderr}
}

const contentText = (result) => (result?.content || []).map((item) => item?.text || '').join('\n')

async function inspectProfile({entryPoint, repoRoot, graphHome, profile, expectedTools, version}) {
    const server = runtime(entryPoint, repoRoot, profile, graphHome)
    try {
        const initialized = await server.request('initialize', {
            protocolVersion: '2024-11-05', capabilities: {},
            clientInfo: {name: 'weavatrix-release-smoke', version: '1.0.0'},
        })
        assert.equal(initialized.serverInfo?.version, version, `${profile}: packaged server version`)
        assert.match(initialized.instructions || '', new RegExp(`profile=${profile}; tools=${expectedTools.length}(?:;|\\b)`), `${profile}: initialize diagnostics`)
        const listed = await server.request('tools/list')
        const names = (listed.tools || []).map((tool) => tool.name).sort()
        assert.deepEqual(names, expectedTools, `${profile}: exact packaged tools/list`)
        assert.deepEqual(listed._meta?.['weavatrix/runtime'], {
            version, profile, capabilities: profile === 'offline'
                ? ['graph', 'search', 'source', 'health', 'build', 'retarget', 'crossrepo']
                : ['graph', 'search', 'source', 'health', 'build', 'retarget', 'crossrepo', 'advisories', 'hosted'],
            toolCount: expectedTools.length,
        }, `${profile}: tools/list runtime diagnostics`)
        return server
    } catch (error) {
        await server.stop()
        error.message = `${error.message}\n${server.stderr()}`
        throw error
    }
}

async function exerciseBehavior(server) {
    const stats = await server.request('tools/call', {
        name: 'graph_stats', arguments: {output_format: 'json'},
    })
    assert.equal(stats.isError, undefined, contentText(stats))
    assert.match(contentText(stats), /Weavatrix runtime: v[^;]+; profile full; 38 registered tools/)

    const search = await server.request('tools/call', {
        name: 'search_code',
        arguments: {query: 'PACKAGED_GLOB_PROBE', glob: 'src/query/**', output_format: 'json'},
    })
    assert.equal(search.isError, undefined, contentText(search))
    assert.deepEqual(
        [...new Set(search.structuredContent?.result?.matches?.map((match) => match.file) || [])],
        ['src/query/query.service.js'],
    )

    const architecture = await server.request('tools/call', {
        name: 'get_architecture_contract', arguments: {output_format: 'json'},
    })
    assert.equal(architecture.isError, undefined, contentText(architecture))
    const components = architecture.structuredContent?.result?.starterContract?.components || []
    assert.ok(components.some((component) => component.paths.includes('src/api')), `architecture starter retains product API territory: ${JSON.stringify(components)}`)
    assert.ok(components.some((component) => component.paths.includes('src/query')), `architecture starter retains product query territory: ${JSON.stringify(components)}`)
    assert.equal(components.some((component) => component.paths.some((path) => /^(?:test|tests|docs|\.github|__temp)(?:\/|$)|^README/i.test(path))), false, 'architecture starter excludes classified/non-code paths')

    const query = await server.request('tools/call', {
        name: 'query_graph',
        arguments: {
            question: 'Trace the main REST API request path from HTTP controller or route through service logic. Focus on production code and identify the best exact symbol to inspect.',
            depth: 1,
        },
    })
    assert.equal(query.isError, undefined, contentText(query))
    const queryText = contentText(query)
    assert.match(queryText, /attack\.router\.js|startMitigate/)
    assert.doesNotMatch(queryText, /jest\.config\.cjs|license-validation\.yml|__temp/)
}

export async function verifyMcpRuntime({entryPoint, repoRoot, graphHome, version, behavior = true}) {
    assert.ok(existsSync(entryPoint), `missing MCP entry point: ${entryPoint}`)
    const profiles = [
        ['offline', OFFLINE_TOOLS],
        ['hosted', FULL_TOOLS],
        ['full', FULL_TOOLS],
    ]
    for (const [profile, expectedTools] of profiles) {
        const server = await inspectProfile({entryPoint, repoRoot, graphHome, profile, expectedTools, version})
        try {
            if (profile === 'full' && behavior) await exerciseBehavior(server)
        } finally { await server.stop() }
    }
}

export function createRuntimeFixture(parent) {
    const repoRoot = join(parent, 'fixture-repo')
    const files = {
        'src/query/query.service.js': 'export const PACKAGED_GLOB_PROBE = true\nexport function executeCompiledQuery() { return PACKAGED_GLOB_PROBE }\n',
        'src/api/attack.router.js': 'import { startMitigate } from "./attack.controller.js"\nexport function startMitigateRoute() { return startMitigate() }\n',
        'src/api/attack.controller.js': 'export function startMitigate() { return "started" }\n',
        'test/query.test.js': 'export const PACKAGED_GLOB_PROBE = "test-only"\n',
        'jest.config.cjs': 'const path = "wrong-rest-seed"\nmodule.exports = { path }\n',
        '.github/workflows/license-validation.yml': 'name: license validation\n',
        '__temp/scratch.js': 'export const startMitigate = "temporary"\n',
        'README.md': '# fixture\n',
    }
    for (const [relativePath, source] of Object.entries(files)) {
        const path = join(repoRoot, relativePath)
        mkdirSync(dirname(path), {recursive: true})
        writeFileSync(path, source)
    }
    // The MCPB fixture lives below ignored dist-mcpb/ in the source checkout. Give it its own Git
    // boundary so discovery cannot accidentally inherit the parent checkout's ignore rules and
    // produce a misleading zero-node graph.
    run('git', ['init', '-q'], repoRoot)
    run('git', ['add', '.'], repoRoot)
    return repoRoot
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, {cwd, encoding: 'utf8', windowsHide: true, shell: false})
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}\n${result.stderr || result.stdout}`)
    return result.stdout
}

function runNpm(args, cwd) {
    const npmCli = process.env.npm_execpath
    if (npmCli && existsSync(npmCli)) return run(process.execPath, [npmCli, ...args], cwd)
    return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd)
}

export async function verifyPackedNpmRuntime(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
    const packageRoot = resolve(root)
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    const temp = mkdtempSync(join(packageRoot, '.release-runtime-'))
    try {
        const packDir = join(temp, 'pack')
        const unpackDir = join(temp, 'unpacked')
        mkdirSync(packDir, {recursive: true})
        mkdirSync(unpackDir, {recursive: true})
        const packed = JSON.parse(runNpm([
            'pack', '--json', '--ignore-scripts', '--pack-destination', packDir,
            '--cache', join(temp, 'npm-cache'),
        ], packageRoot))
        const tarball = join(packDir, packed?.[0]?.filename || '')
        assert.ok(existsSync(tarball), 'npm pack did not produce the declared tarball')
        run('tar', ['-xzf', tarball, '-C', unpackDir], packageRoot)
        const extracted = join(unpackDir, 'package')
        const extractedPackage = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
        assert.equal(extractedPackage.version, pkg.version, 'packed package version')
        const repoRoot = createRuntimeFixture(temp)
        await verifyMcpRuntime({
            entryPoint: join(extracted, 'bin', 'weavatrix-mcp.mjs'),
            repoRoot,
            graphHome: join(temp, 'graphs'),
            version: pkg.version,
        })
    } finally {
        rmSync(temp, {recursive: true, force: true})
    }
}
