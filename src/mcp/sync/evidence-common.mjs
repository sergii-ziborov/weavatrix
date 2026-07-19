export const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info'])
export const CONFIDENCE = new Set(['high', 'medium', 'low'])
export const CATEGORIES = new Set(['unused', 'structure', 'vulnerability', 'malware'])
export const CHECK_KEYS = ['osv', 'malware']
export const PACKAGE_DEPENDENCY_KINDS = new Set(['runtime', 'dev', 'optional', 'peer', 'optional-peer'])
export const CAPS = Object.freeze({
    modules: 500, dependencies: 2000, findings: 500, hotspots: 250, badges: 100,
    packages: 5000, usage: 1000, files: 20, packageGraphNodes: 5000, packageGraphEdges: 20000,
    duplicateGroups: 100, duplicateMembers: 12, divergenceCandidates: 100,
})
export const DUPLICATE_THRESHOLDS = Object.freeze({
    clones: Object.freeze({mode: 'renamed', minSimilarityPercent: 80, minTokens: 50}),
    divergence: Object.freeze({sameName: true, maxSimilarityPercent: 45, minTokens: 50, maxImplementationsPerName: 12}),
})

const STATES = new Set(['COMPLETE', 'PARTIAL', 'NOT_CHECKED', 'NOT_APPLICABLE', 'ERROR'])
const VERDICTS = new Set(['PASS', 'FAIL', 'UNKNOWN'])
const CONTROL = /[\u0000-\u001f\u007f]/
const ABSOLUTE_PATH_FRAGMENT = /(?:^|[\/\s"'`(=])[a-z]:[\\/]|(?:^|[\s"'`(=])(?:\\\\[^\\/\s]+(?:[\\/]|$)|file:(?:\/\/)?[\\/]|\/(?!\/)[^\s])/i
const TOKEN = /^[\p{L}\p{N}_.:@+\-#$<>()\[\],]+$/u
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i

export const int = (value) => Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
export const bool = (value) => value === true
export const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value) ? value : undefined
export const token = (value, max = 256) => { const valueText = text(value, max); return valueText && TOKEN.test(valueText) ? valueText : undefined }
export const privacySafeText = (value, max = 256) => { const valueText = text(value, max); return valueText && !ABSOLUTE_PATH_FRAGMENT.test(valueText) ? valueText : undefined }
export const packageName = (value) => { const valueText = text(value, 256); return valueText && PACKAGE.test(valueText) ? valueText : undefined }
export const packageVersion = (value) => { const valueText = text(value, 128); return valueText && /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(valueText) ? valueText : undefined }
export const state = (value) => STATES.has(value) ? value : 'ERROR'
export const verdict = (value) => VERDICTS.has(value) ? value : 'UNKNOWN'
export const compare = (a, b) => String(a).localeCompare(String(b), 'en')

export function path(value, max = 4096) {
    const raw = text(value, max)
    if (!raw) return undefined
    const normalized = raw.replace(/\\/g, '/')
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(normalized)) return undefined
    const parts = normalized.split('/')
    return parts.length && parts.every((part) => part && part !== '.' && part !== '..') ? normalized : undefined
}

export function graphId(value) {
    const id = text(value, 4096)
    if (!id) return undefined
    const hash = id.indexOf('#')
    const file = hash < 0 ? id : id.slice(0, hash)
    const safeFile = path(file)
    if (!safeFile) return undefined
    if (hash < 0) return safeFile
    const suffix = id.slice(hash)
    return suffix.length <= 512 && /^#[^\\/\s\u0000-\u001f\u007f]{1,511}$/u.test(suffix) ? `${safeFile}${suffix}` : undefined
}

export function moduleId(value) { return value === '(root)' ? value : path(value) }
export function set(out, key, value) { if (value !== undefined) out[key] = value }

export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    return JSON.stringify(value)
}

export function list(values, cap, mapper, sorter) {
    const all = (Array.isArray(values) ? values : []).map(mapper).filter(Boolean).sort(sorter)
    return {items: all.slice(0, cap), total: all.length, truncated: all.length > cap}
}

export function count(value, fallbackTotal, returned) {
    const total = Math.max(int(value?.total), fallbackTotal)
    return {total, returned, truncated: bool(value?.truncated) || total > returned}
}

export function reasons(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => token(value, 96)).filter(Boolean))].sort(compare).slice(0, 32)
}

export function numericRecord(value, keys) {
    const out = {}
    for (const key of keys) out[key] = int(value?.[key])
    return out
}

export function checks(value) {
    const out = {}
    for (const key of CHECK_KEYS) out[key] = state(value?.[key])
    return out
}
