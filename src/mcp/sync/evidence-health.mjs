import {
    CAPS, CATEGORIES, CONFIDENCE, SEVERITIES, checks, compare, count, graphId,
    int, list, numericRecord, packageName, path, privacySafeText, reasons, set,
    state, text, token, verdict,
} from './evidence-common.mjs'

function finding(value) {
    if (!value || typeof value !== 'object') return null
    const id = text(value.id, 64), category = token(value.category, 32), rule = token(value.rule, 64), severity = token(value.severity, 16)
    if (!id || !/^[a-f0-9]{8,64}$/i.test(id) || !CATEGORIES.has(category) || !rule || !SEVERITIES.has(severity)) return null
    const out = {id, category, rule, severity}
    if (CONFIDENCE.has(value.confidence)) out.confidence = value.confidence
    set(out, 'file', path(value.file)); set(out, 'line', Number.isFinite(value.line) && value.line >= 0 ? Math.trunc(value.line) : undefined)
    set(out, 'symbol', privacySafeText(value.symbol)); set(out, 'package', packageName(value.package)); set(out, 'version', token(value.version, 128)); set(out, 'graphNodeId', graphId(value.graphNodeId))
    return out
}

function hotspot(value) {
    const id = graphId(value?.id), file = path(value?.file), severity = token(value?.severity, 16)
    if (!id || !file || !['medium', 'high'].includes(severity)) return null
    const out = {id, file, severity, breaches: [...new Set((value.breaches || []).map((item) => token(item, 48)).filter(Boolean))].sort(compare).slice(0, 12)}
    set(out, 'symbol', privacySafeText(value.symbol))
    for (const key of ['startLine', 'endLine', 'loc', 'cyclomatic', 'params']) if (Number.isFinite(value[key]) && value[key] >= 0) out[key] = Math.trunc(value[key])
    return out
}

export function sanitizeHealth(value) {
    const findings = list(value?.findings, CAPS.findings, finding, (a, b) => compare(a.severity, b.severity) || compare(a.id, b.id))
    const hotspots = list(value?.complexity?.hotspots, CAPS.hotspots, hotspot, (a, b) => compare(a.severity, b.severity) || compare(a.id, b.id))
    const truncated = findings.truncated || hotspots.truncated
    const outState = state(value?.state)
    return {
        state: truncated && outState === 'COMPLETE' ? 'PARTIAL' : outState, verdict: verdict(value?.verdict),
        completeness: {findings: count(value?.completeness?.findings, findings.total, findings.items.length), hotspots: count(value?.completeness?.hotspots, hotspots.total, hotspots.items.length), reasons: reasons(value?.completeness?.reasons)},
        summary: {
            bySeverity: numericRecord(value?.summary?.bySeverity, ['critical', 'high', 'medium', 'low', 'info']),
            byCategory: numericRecord(value?.summary?.byCategory, ['unused', 'structure', 'vulnerability', 'malware']),
            dead: numericRecord(value?.summary?.dead, ['deadSymbols', 'deadFiles', 'unusedExports']),
            structure: numericRecord(value?.summary?.structure, ['runtimeImportEdges', 'typeOnlyImportEdges', 'compileOnlyImportEdges', 'runtimeCycles', 'compileTimeCouplings', 'largestCycle', 'largestCompileTimeCoupling', 'orphans', 'boundaryViolations']),
        },
        checks: checks(value?.checks), findings: findings.items,
        complexity: {thresholds: {loc: {warning: int(value?.complexity?.thresholds?.loc?.warning), high: int(value?.complexity?.thresholds?.loc?.high)}, cyclomatic: {warning: int(value?.complexity?.thresholds?.cyclomatic?.warning), high: int(value?.complexity?.thresholds?.cyclomatic?.high)}, params: {warning: int(value?.complexity?.thresholds?.params?.warning), high: int(value?.complexity?.thresholds?.params?.high)}}, analyzed: int(value?.complexity?.analyzed), hotspots: hotspots.items},
    }
}

function badge(value) {
    const category = token(value?.category, 32), id = token(value?.id, 128)
    if (!['languages', 'runtimes', 'tests', 'infra', 'deploy'].includes(category) || !id) return null
    const out = {category, id}; set(out, 'kind', token(value.kind, 64)); set(out, 'version', token(value.version, 64)); return out
}

export function sanitizeTechnologies(value) {
    const badges = list(value?.badges, CAPS.badges, badge, (a, b) => compare(a.category, b.category) || compare(a.id, b.id))
    const outState = state(value?.state)
    return {state: badges.truncated && outState === 'COMPLETE' ? 'PARTIAL' : outState, verdict: verdict(value?.verdict), completeness: {badges: count(value?.completeness?.badges, badges.total, badges.items.length), reasons: reasons(value?.completeness?.reasons)}, badges: badges.items}
}
