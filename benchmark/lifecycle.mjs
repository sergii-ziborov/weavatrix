import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const SERVER = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))
const PROJECT_ROOT = dirname(dirname(SERVER))
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

function startServer(graphPath, repoRoot, graphHome) {
    const child = spawn(process.execPath, [SERVER, graphPath, repoRoot], {
        cwd: PROJECT_ROOT,
        env: {...process.env, WEAVATRIX_GRAPH_HOME: graphHome, WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS: '0'},
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = '', stderr = '', nextId = 1
    const pending = new Map()
    const rejectPending = (error) => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
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
            const entry = pending.get(message.id)
            if (!entry) continue
            pending.delete(message.id)
            clearTimeout(entry.timer)
            if (message.error) entry.reject(new Error(message.error.message || 'MCP request failed'))
            else entry.resolve(message.result)
        }
    })
    child.once('error', rejectPending)
    child.once('exit', (code, signal) => rejectPending(new Error(`MCP exited before replying (${code ?? signal}): ${stderr}`)))
    const request = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`MCP request timed out: ${method}: ${stderr}`))
        }, timeoutMs)
        pending.set(id, {resolve, reject, timer})
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`)
    })
    const initialize = async () => {
        await request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'weavatrix-benchmark', version: '1'}})
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized', params: {}})}\n`)
    }
    const stop = async () => {
        if (child.exitCode != null || child.signalCode != null) return
        child.stdin.end()
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1_000))])
        if (child.exitCode == null && child.signalCode == null) child.kill()
    }
    return {initialize, request, stop}
}

async function stats(server, outputFormat = 'json') {
    return server.request('tools/call', {name: 'graph_stats', arguments: {output_format: outputFormat}})
}

export async function benchmarkLifecycle(fixtureRoot) {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-benchmark-lifecycle-'))
    const repo = join(parent, 'typescript')
    const graphHome = join(parent, 'graphs')
    const graphPath = join(parent, 'classic', 'graph.json')
    mkdirSync(dirname(graphPath), {recursive: true})
    cpSync(fixtureRoot, repo, {recursive: true})
    let firstServer, secondServer
    try {
        firstServer = startServer(graphPath, repo, graphHome)
        await firstServer.initialize()
        const cold = await stats(firstServer)
        const text = await stats(firstServer, 'text')
        const source = join(repo, 'src', 'index.ts')
        writeFileSync(source, readFileSync(source, 'utf8').replace("'benchmark'", "'benchmarK'"))
        const incremental = await stats(firstServer)
        const unchanged = await stats(firstServer)
        await firstServer.stop()
        firstServer = null

        const reconnectStarted = performance.now()
        secondServer = startServer(graphPath, repo, graphHome)
        await secondServer.initialize()
        const reconnected = await stats(secondServer)
        const reconnectMs = performance.now() - reconnectStarted
        return {
            coldUpdate: cold.structuredContent?.graph?.update || null,
            incrementalUpdate: incremental.structuredContent?.graph?.update || null,
            unchangedUpdate: unchanged.structuredContent?.graph?.update || null,
            reconnectUpdate: reconnected.structuredContent?.graph?.update || null,
            reconnectMs: Number(reconnectMs.toFixed(2)),
            textResponseBytes: bytes(text),
            activeTargetStable: cold.structuredContent?.repo?.name === reconnected.structuredContent?.repo?.name,
            revisionStable: unchanged.structuredContent?.graph?.revision === reconnected.structuredContent?.graph?.revision,
        }
    } finally {
        if (firstServer) await firstServer.stop()
        if (secondServer) await secondServer.stop()
        rmSync(parent, {recursive: true, force: true})
    }
}
