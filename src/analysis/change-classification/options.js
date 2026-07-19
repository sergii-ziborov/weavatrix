export const CHANGE_CLASSIFICATION_LIMITS = Object.freeze({
    maxDiffBytes: 2 * 1024 * 1024,
    maxFiles: 500,
    maxChangedLines: 20_000,
    maxLineLength: 4_000,
    maxSymbolsPerFile: 250,
    maxSeeds: 1_000,
})

export const CHANGE_CLASS_RANK = Object.freeze({
    'metadata-only': 0,
    'test-only': 0,
    added: 1,
    'body-changed': 2,
    'signature-changed': 3,
    removed: 4,
    unknown: 5,
})

export const normalizeChangePath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
export const changeLineNumber = (value) => Number((String(value || '').match(/(?:^L|@)(\d+)$/) || [])[1] || 0)
export const bareGraphLabel = (value) => String(value || '').replace(/\(.*$/, '').replace(/[^A-Za-z0-9_$].*$/, '').trim()

export function changeLimits(value = {}) {
    const bounded = (item, fallback, min, max) => Math.max(min, Math.min(max, Number(item) || fallback))
    const defaults = CHANGE_CLASSIFICATION_LIMITS
    return {
        maxDiffBytes: bounded(value.maxDiffBytes, defaults.maxDiffBytes, 1_024, defaults.maxDiffBytes),
        maxFiles: bounded(value.maxFiles, defaults.maxFiles, 1, defaults.maxFiles),
        maxChangedLines: bounded(value.maxChangedLines, defaults.maxChangedLines, 10, defaults.maxChangedLines),
        maxLineLength: bounded(value.maxLineLength, defaults.maxLineLength, 80, defaults.maxLineLength),
        maxSymbolsPerFile: bounded(value.maxSymbolsPerFile, defaults.maxSymbolsPerFile, 1, defaults.maxSymbolsPerFile),
        maxSeeds: bounded(value.maxSeeds, defaults.maxSeeds, 1, defaults.maxSeeds),
    }
}

export function uniqueChangeSeeds(values, limit) {
    const all = [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b))
    return {items: all.slice(0, limit), truncated: all.length > limit, total: all.length}
}
