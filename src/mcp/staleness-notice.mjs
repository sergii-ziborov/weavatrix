// Staleness is important, but repeating an identical paragraph after every graph call drowns the
// actual answer. Surface a changed condition immediately, then remind periodically. graph_stats can
// force the notice because freshness is the purpose of that tool.
export function createStalenessNoticeGate(cooldownMs = 5 * 60_000) {
    let lastKey = ''
    let lastShownAt = 0
    return {
        shouldShow({line, graphPath = '', force = false, now = Date.now()} = {}) {
            if (!line) return false
            const key = `${graphPath}\u0000${line}`
            if (force || key !== lastKey || now - lastShownAt >= cooldownMs) {
                lastKey = key
                lastShownAt = now
                return true
            }
            return false
        },
        reset() { lastKey = ''; lastShownAt = 0 },
    }
}
