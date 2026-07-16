// Small cross-process lock + atomic file replacement helpers for derived graph state. Multiple MCP
// clients commonly run at once (Claude, Codex, desktop); a plain read -> write sequence can lose a
// registry record or expose a half-written multi-megabyte graph to another reader.
import {mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import process from 'node:process'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function clearStaleLock(lockDir, staleMs) {
    try {
        if (Date.now() - statSync(lockDir).mtimeMs <= staleMs) return false
        try {
            const ownerPid = Number(readFileSync(`${lockDir}/owner`, 'utf8').split(/\s+/)[0])
            if (Number.isInteger(ownerPid) && ownerPid > 0) {
                try { process.kill(ownerPid, 0); return false }
                catch (error) { if (error?.code === 'EPERM') return false }
            }
        } catch { /* missing owner: stale age remains the authority */ }
        rmSync(lockDir, {recursive: true, force: true})
        return true
    } catch { return false }
}

function acquired(lockDir) {
    mkdirSync(dirname(lockDir), {recursive: true})
    try {
        mkdirSync(lockDir)
        writeFileSync(`${lockDir}/owner`, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8')
        return true
    } catch (error) {
        if (error?.code === 'EEXIST') return false
        throw error
    }
}

export async function withFileLock(lockDir, fn, {timeoutMs = 10_000, staleMs = 60_000, pollMs = 25} = {}) {
    const started = Date.now()
    while (!acquired(lockDir)) {
        clearStaleLock(lockDir, staleMs)
        if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for derived-state lock: ${lockDir}`)
        await wait(pollMs)
    }
    try { return await fn() }
    finally { rmSync(lockDir, {recursive: true, force: true}) }
}

export function withFileLockSync(lockDir, fn, {timeoutMs = 10_000, staleMs = 60_000, pollMs = 20} = {}) {
    const started = Date.now()
    while (!acquired(lockDir)) {
        clearStaleLock(lockDir, staleMs)
        if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for derived-state lock: ${lockDir}`)
        waitSync(pollMs)
    }
    try { return fn() }
    finally { rmSync(lockDir, {recursive: true, force: true}) }
}

export function atomicWriteFileSync(path, data, encoding = undefined) {
    mkdirSync(dirname(path), {recursive: true})
    const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    try {
        writeFileSync(temp, data, encoding)
        renameSync(temp, path)
    } finally {
        try { rmSync(temp, {force: true}) } catch { /* already renamed */ }
    }
}
