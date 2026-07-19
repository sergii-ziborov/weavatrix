import {isAbsolute} from 'node:path'

export const GIT_HISTORY_V = 1
export const GIT_HISTORY_WINDOWS = Object.freeze([3, 6, 12])
export const GIT_HISTORY_DEFAULTS = Object.freeze({
    months: 6,
    maxCommits: 500,
    maxFilesPerCommit: 80,
    maxPairs: 100,
    minPairCount: 2,
    maxPairCandidates: 100_000,
    maxOutputBytes: 16 * 1024 * 1024,
    timeoutMs: 20_000,
})
export const GIT_HISTORY_HARD_CAPS = Object.freeze({
    maxCommits: 2_000,
    maxFilesPerCommit: 200,
    maxPairs: 500,
    maxPairCandidates: 250_000,
    maxOutputBytes: 64 * 1024 * 1024,
    timeoutMs: 60_000,
})
export const GIT_FORMAT = '%x1e%H%x1f%ct'

export const graphEndpoint = (value) => value && typeof value === 'object' ? value.id : value
export const roundHistoryNumber = (value, digits = 4) => {
    if (!Number.isFinite(value)) return 0
    const scale = 10 ** digits
    return Math.round(value * scale) / scale
}
export const boundedHistoryInteger = (value, fallback, min, max) => {
    const number = Number(value)
    return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback
}

export function safeHistoryPath(value) {
    const path = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!path || path.includes('\0') || isAbsolute(path) || /^[a-z]:\//i.test(path)) return null
    if (/[\x00-\x1f\x7f]/.test(path)) return null
    const parts = path.split('/')
    return parts.some((part) => !part || part === '.' || part === '..') ? null : path
}

export function utcMonthsBefore(date, months) {
    const source = new Date(date)
    if (!Number.isFinite(source.getTime())) throw new Error('now must be a valid date')
    const targetMonth = source.getUTCMonth() - months
    const first = new Date(Date.UTC(source.getUTCFullYear(), targetMonth, 1, source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()))
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
    first.setUTCDate(Math.min(source.getUTCDate(), lastDay))
    return first
}

export function normalizeGitHistoryOptions(input = {}) {
    const defaults = GIT_HISTORY_DEFAULTS, caps = GIT_HISTORY_HARD_CAPS
    const months = Number(input.months ?? defaults.months)
    if (!GIT_HISTORY_WINDOWS.includes(months)) throw new Error('months must be one of 3, 6 or 12')
    return {
        months,
        maxCommits: boundedHistoryInteger(input.maxCommits, defaults.maxCommits, 1, caps.maxCommits),
        maxFilesPerCommit: boundedHistoryInteger(input.maxFilesPerCommit, defaults.maxFilesPerCommit, 2, caps.maxFilesPerCommit),
        maxPairs: boundedHistoryInteger(input.maxPairs, defaults.maxPairs, 1, caps.maxPairs),
        minPairCount: boundedHistoryInteger(input.minPairCount, defaults.minPairCount, 1, 100),
        maxPairCandidates: boundedHistoryInteger(input.maxPairCandidates, defaults.maxPairCandidates, 100, caps.maxPairCandidates),
        maxOutputBytes: boundedHistoryInteger(input.maxOutputBytes, defaults.maxOutputBytes, 64 * 1024, caps.maxOutputBytes),
        timeoutMs: boundedHistoryInteger(input.timeoutMs, defaults.timeoutMs, 1_000, caps.timeoutMs),
    }
}
