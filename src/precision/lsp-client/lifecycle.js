import {spawn as spawnChild} from 'node:child_process'
import {positiveInteger} from './constants.js'
import {lspChildProcessEnv} from './environment.js'
import {LspTimeoutError} from './errors.js'
import {isLspClientActive} from './registry.js'
import {notifyClient, rejectPendingRequests, requestFromClient} from './protocol.js'

export function failClient(client, error) {
    if (client.state === 'closed' || client.state === 'failed') return
    client.state = 'failed'
    rejectPendingRequests(client, error)
    killClient(client, error)
}

export function killClient(client, reason = new Error('LSP client was killed')) {
    if (client.state !== 'closed') client.state = 'closed'
    rejectPendingRequests(client, reason)
    client.openDocuments.clear()
    try { client.child.stdin?.destroy() } catch { /* already closed */ }
    if (process.platform !== 'win32' && client.processGroupPid) {
        try {
            process.kill(-client.processGroupPid, 'SIGKILL')
            return
        } catch { /* fall through to direct child */ }
    }
    if (client.child.exitCode != null || client.child.signalCode != null) return
    if (process.platform === 'win32' && client.child.pid) {
        startWindowsTreeKill(client)
    } else {
        try { client.child.kill('SIGKILL') } catch { /* already exited */ }
    }
}

function directChildKill(client) {
    try { client.child.kill('SIGKILL') } catch { /* already exited */ }
}

function startWindowsTreeKill(client) {
    if (client.windowsTreeKillPromise) return client.windowsTreeKillPromise
    client.windowsTreeKillPromise = new Promise((resolveKill) => {
        try {
            const killer = spawnChild('taskkill', ['/pid', String(client.child.pid), '/T', '/F'], {
                shell: false,
                windowsHide: true,
                env: lspChildProcessEnv(),
                stdio: 'ignore',
            })
            killer.once('error', () => { directChildKill(client); resolveKill() })
            killer.once('exit', (code) => { if (code !== 0) directChildKill(client); resolveKill() })
        } catch {
            directChildKill(client)
            resolveKill()
        }
    })
    return client.windowsTreeKillPromise
}

export async function killWindowsTreeAndWait(client, timeoutMs = 3_000) {
    if (process.platform !== 'win32' || !client.child.pid || client.child.exitCode != null) return
    const boundedTimeout = Math.max(250, Math.min(5_000, Number(timeoutMs) || 3_000))
    let timer
    await Promise.race([
        startWindowsTreeKill(client),
        new Promise((resolveKill) => {
            timer = setTimeout(() => { directChildKill(client); resolveKill() }, boundedTimeout)
        }),
    ])
    if (timer) clearTimeout(timer)
}

export async function waitForClientExit(client, timeoutMs = client.requestTimeoutMs) {
    if (!isLspClientActive(client)) return true
    const boundedTimeout = Math.max(100, Math.min(10_000, Number(timeoutMs) || client.requestTimeoutMs))
    let timer
    const outcome = await Promise.race([
        client.exited.then(() => true),
        new Promise((resolveExit) => { timer = setTimeout(() => resolveExit(false), boundedTimeout) }),
    ])
    if (timer) clearTimeout(timer)
    return outcome
}

export function shutdownClient(client, options = {}) {
    if (!client.shutdownPromise) client.shutdownPromise = shutdownClientOnce(client, options)
    return client.shutdownPromise
}

export async function shutdownClientOnce(client, {timeoutMs = client.requestTimeoutMs} = {}) {
    const boundedTimeout = positiveInteger(timeoutMs, client.requestTimeoutMs, 'timeoutMs')
    try {
        if (client.state === 'starting') await client.spawned
        if (client.state === 'closed') {
            await waitForClientExit(client, boundedTimeout)
            return
        }
        if (client.state === 'initialized') {
            await requestFromClient(client, 'shutdown', null, {timeoutMs: boundedTimeout})
        }
        client.state = 'stopping'
        await notifyClient(client, 'exit', null)
        await killWindowsTreeAndWait(client, Math.min(3_000, boundedTimeout))
        if (process.platform !== 'win32' && client.processGroupPid) {
            await waitForClientExit(client, Math.min(1_000, boundedTimeout))
            try { process.kill(-client.processGroupPid, 'SIGKILL') } catch { /* group already exited */ }
        }
        if (!await waitForClientExit(client, boundedTimeout)) {
            killClient(client, new LspTimeoutError('exit', boundedTimeout))
        }
    } catch (error) {
        killClient(client, error)
        await killWindowsTreeAndWait(client, Math.min(2_000, boundedTimeout))
        await waitForClientExit(client, Math.min(2_000, boundedTimeout))
    }
}
