import process from 'node:process'
import {
    activeLspClientCount,
    beginLspClientShutdown,
    shutdownActiveLspClients,
} from '../../precision/lsp-client.js'

async function settleWithin(promise, timeoutMs) {
    let timer
    const settled = await Promise.race([
        Promise.resolve(promise).then(() => true, () => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    if (timer) clearTimeout(timer)
    return settled
}

export function createShutdownController({log, targetMutation}) {
    let shuttingDown = false, shutdownPromise = null
    const request = (reason, exitCode = 0) => {
        if (shutdownPromise) return shutdownPromise
        shuttingDown = true
        beginLspClientShutdown()
        process.stdin.pause()
        const activeAtStart = activeLspClientCount()
        log(`shutdown requested (${reason}); draining graph work and ${activeAtStart} semantic provider(s)`)
        shutdownPromise = (async () => {
            const initiallyDrained = await settleWithin(targetMutation(), 2_500)
            const semantic = await shutdownActiveLspClients({timeoutMs: 3_000})
            const fullyDrained = initiallyDrained || await settleWithin(targetMutation(), 1_500)
            log(`shutdown cleanup: graph=${fullyDrained ? 'drained' : 'bounded-timeout'}, semantic=${semantic.requested} requested/${semantic.remaining} remaining${semantic.timedOut ? ' (forced)' : ''}`)
        })().catch((error) => {
            log(`shutdown cleanup failed: ${error.stack || error.message}`)
        }).finally(() => {
            process.exit(exitCode)
        })
        return shutdownPromise
    }
    return {isShuttingDown: () => shuttingDown, request}
}
