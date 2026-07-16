import {createHash} from 'node:crypto'

export const STATE = Object.freeze({
    COMPLETE: 'COMPLETE',
    PARTIAL: 'PARTIAL',
    NOT_CHECKED: 'NOT_CHECKED',
    NOT_APPLICABLE: 'NOT_APPLICABLE',
    ERROR: 'ERROR',
})

export const VERDICT = Object.freeze({PASS: 'PASS', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN'})

export const CAPS = Object.freeze({
    modules: 500,
    moduleDependencies: 2_000,
    architectureFindings: 150,
    findings: 500,
    hotspots: 250,
    stackBadges: 100,
    packages: 5_000,
    directUsage: 1_000,
    usageFiles: 20,
})

export const COMPLEXITY_THRESHOLDS = Object.freeze({
    loc: Object.freeze({warning: 120, high: 300}),
    cyclomatic: Object.freeze({warning: 15, high: 30}),
    params: Object.freeze({warning: 6, high: 10}),
})

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const ABSOLUTE_PATH_FRAGMENT = /(?:^|[\/\s"'`(=])[a-z]:[\\/]|(?:^|[\s"'`(=])(?:\\\\[^\\/\s]+(?:[\\/]|$)|file:(?:\/\/)?[\\/]|\/(?!\/)[^\s])/i
const SAFE_TOKEN = /^[A-Za-z0-9@][A-Za-z0-9._:+/@-]*$/
const SAFE_RULE = /^[a-z0-9][a-z0-9._-]*$/
const SAFE_FINDING_ID = /^[a-f0-9]{8,64}$/i
const SAFE_SEVERITY = new Set(['critical', 'high', 'medium', 'low', 'info'])
const SAFE_CONFIDENCE = new Set(['high', 'medium', 'low'])
const SAFE_CATEGORY = new Set(['unused', 'structure', 'vulnerability', 'malware'])
const SAFE_CHECK_STATE = new Set(Object.values(STATE))

export function metadataString(value, max = 512) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value)
        ? value
        : undefined
}

export function privacySafeText(value, max = 512) {
    const text = metadataString(value, max)
    return text && !ABSOLUTE_PATH_FRAGMENT.test(text) ? text : undefined
}

export function safeToken(value, max = 256) {
    const text = metadataString(value, max)
    return text && SAFE_TOKEN.test(text) ? text : undefined
}

export function repoRelativePath(value, max = 4096) {
    const raw = metadataString(value, max)
    if (!raw) return undefined
    const path = raw.replace(/\\/g, '/')
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path)) return undefined
    const segments = path.split('/')
    if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined
    return path
}

export function graphId(value) {
    const id = metadataString(value, 4096)
    if (!id) return undefined
    const hash = id.indexOf('#')
    const file = hash < 0 ? id : id.slice(0, hash)
    return repoRelativePath(file) ? id.replace(/\\/g, '/') : undefined
}

export function moduleId(value) {
    if (value === '(root)') return '(root)'
    return repoRelativePath(value)
}

export function nonNegativeInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : 0
}

export function optionalNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : undefined
}

export function addIf(out, key, value) {
    if (value !== undefined) out[key] = value
}

export function compareText(a, b) {
    return String(a).localeCompare(String(b), 'en')
}

export function bounded(sortedItems, cap) {
    const items = sortedItems.slice(0, cap)
    return {
        items,
        completeness: {
            total: sortedItems.length,
            returned: items.length,
            truncated: sortedItems.length > items.length,
        },
    }
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

export function hashSnapshot(snapshot) {
    return createHash('sha256').update(stableStringify(snapshot)).digest('hex')
}

export function normalizeCheckState(value) {
    if (value === 'OK') return STATE.COMPLETE
    return SAFE_CHECK_STATE.has(value) ? value : STATE.ERROR
}

export function sanitizeFinding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const id = metadataString(value.id, 64)
    const category = metadataString(value.category, 32)
    const rule = metadataString(value.rule, 64)
    const severity = metadataString(value.severity, 16)
    if (!id || !SAFE_FINDING_ID.test(id) || !category || !SAFE_CATEGORY.has(category) ||
        !rule || !SAFE_RULE.test(rule) || !severity || !SAFE_SEVERITY.has(severity)) return null

    const out = {id, category, rule, severity}
    const confidence = metadataString(value.confidence, 16)
    if (confidence && SAFE_CONFIDENCE.has(confidence)) out.confidence = confidence
    addIf(out, 'file', repoRelativePath(value.file))
    const line = optionalNonNegativeInteger(value.line)
    if (line !== undefined) out.line = line
    addIf(out, 'symbol', privacySafeText(value.symbol, 256))
    addIf(out, 'package', safeToken(value.package))
    addIf(out, 'version', safeToken(value.version, 128))
    addIf(out, 'graphNodeId', graphId(value.graphNodeId))
    return out
}

export function numericRecord(value, keys) {
    const out = {}
    for (const key of keys) out[key] = nonNegativeInteger(value?.[key])
    return out
}
