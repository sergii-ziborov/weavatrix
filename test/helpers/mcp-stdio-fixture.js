import {spawn} from 'node:child_process'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

export const MCP_SERVER = fileURLToPath(new URL('../../src/mcp-server.mjs', import.meta.url))
export const PROJECT_ROOT = dirname(dirname(MCP_SERVER))

export function startServer(graphPath, repoRoot, graphHome, extraEnv = {}, capsArg, serverPath = MCP_SERVER) {
    const child = spawn(process.execPath, [serverPath, graphPath, repoRoot, ...(capsArg == null ? [] : [capsArg])], {
        cwd: PROJECT_ROOT,
        env: {...process.env, WEAVATRIX_GRAPH_HOME: graphHome, WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS: '0', ...extraEnv},
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = '', stderr = '', nextId = 1, exitResult = null, resolveExit
    const pending = new Map()
    const exited = new Promise((resolve) => { resolveExit = resolve })
    const failPending = (error) => {
        for (const {reject, timer} of pending.values()) { clearTimeout(timer); reject(error) }
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
    child.once('error', failPending)
    child.once('exit', (code, signal) => {
        exitResult = {code, signal}
        resolveExit(exitResult)
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
    const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method, params})}\n`)
    const endInput = () => {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
    }
    const waitForExit = async (timeoutMs = 10_000) => {
        if (exitResult) return exitResult
        let timer
        try {
            return await Promise.race([
                exited,
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP server did not exit within ${timeoutMs}ms\n${stderr}`)), timeoutMs) }),
            ])
        } finally { if (timer) clearTimeout(timer) }
    }
    const stop = async () => {
        if (child.exitCode != null || child.signalCode != null) return
        endInput()
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8_000))])
        if (child.exitCode == null && child.signalCode == null) child.kill()
        if (child.exitCode == null && child.signalCode == null) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))])
    }
    return {
        request, notify, endInput, closeOutput: () => child.stdout.destroy(),
        waitForExit, stop, stderr: () => stderr,
    }
}
