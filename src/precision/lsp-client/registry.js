const ACTIVE_LSP_CLIENTS = new Set()
let acceptingLspClients = true

export function assertLspClientCreationAllowed() {
    if (!acceptingLspClients) throw new Error('LSP process creation is disabled during MCP shutdown')
}

export function registerLspClient(client) {
    ACTIVE_LSP_CLIENTS.add(client)
}

export function unregisterLspClient(client) {
    ACTIVE_LSP_CLIENTS.delete(client)
}

export function isLspClientActive(client) {
    return ACTIVE_LSP_CLIENTS.has(client)
}

export function activeLspClientCount() {
    return ACTIVE_LSP_CLIENTS.size
}

export function beginLspClientShutdown() {
    acceptingLspClients = false
}

export async function shutdownActiveLspClients({timeoutMs = 3_000} = {}) {
    const boundedTimeout = Math.max(250, Math.min(10_000, Number(timeoutMs) || 3_000))
    const startedAt = Date.now()
    const clients = [...ACTIVE_LSP_CLIENTS]
    if (!clients.length) return {requested: 0, remaining: 0, timedOut: false}
    let timer
    const gracefulBudget = Math.max(125, Math.floor(boundedTimeout * 0.6))
    const graceful = Promise.allSettled(clients.map((client) => client.shutdown({timeoutMs: boundedTimeout})))
    const outcome = await Promise.race([
        graceful.then(() => 'closed'),
        new Promise((resolveOutcome) => { timer = setTimeout(() => resolveOutcome('timeout'), gracefulBudget) }),
    ])
    if (timer) clearTimeout(timer)
    const survivors = [...ACTIVE_LSP_CLIENTS]
    if (survivors.length) {
        const reason = new Error(`MCP shutdown timed out with ${ACTIVE_LSP_CLIENTS.size} active LSP client(s)`)
        const forceBudget = Math.max(100, boundedTimeout - (Date.now() - startedAt))
        await Promise.allSettled(survivors.map(async (client) => {
            if (typeof client.killWindowsTreeAndWait === 'function') await client.killWindowsTreeAndWait(forceBudget)
            client.kill(reason)
            if (typeof client.waitForExit === 'function') {
                await client.waitForExit(Math.max(100, boundedTimeout - (Date.now() - startedAt)))
            }
        }))
    }
    return {
        requested: clients.length,
        remaining: ACTIVE_LSP_CLIENTS.size,
        timedOut: outcome === 'timeout' || ACTIVE_LSP_CLIENTS.size > 0,
    }
}
