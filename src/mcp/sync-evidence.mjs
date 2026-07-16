// Defense-in-depth wire sanitizer for evidence snapshots. The local evidence builder is trusted code,
// but its inputs (graph.json, manifests and cached advisory metadata) are not. Reconstruct every field
// from a small schema here so source text, absolute paths and future analyzer fields cannot hitchhike.
import {createHash} from 'node:crypto'

const STATES = new Set(['COMPLETE', 'PARTIAL', 'NOT_CHECKED', 'NOT_APPLICABLE', 'ERROR'])
const VERDICTS = new Set(['PASS', 'FAIL', 'UNKNOWN'])
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info'])
const CONFIDENCE = new Set(['high', 'medium', 'low'])
const CATEGORIES = new Set(['unused', 'structure', 'vulnerability', 'malware'])
const CHECK_KEYS = ['osv', 'malware']
const CONTROL = /[\u0000-\u001f\u007f]/
const ABSOLUTE_PATH_FRAGMENT = /(?:^|[\/\s"'`(=])[a-z]:[\\/]|(?:^|[\s"'`(=])(?:\\\\[^\\/\s]+(?:[\\/]|$)|file:(?:\/\/)?[\\/]|\/(?!\/)[^\s])/i
const TOKEN = /^[\p{L}\p{N}_.:@+\-#$<>()\[\],]+$/u
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i
const CAPS = Object.freeze({modules: 500, dependencies: 2000, findings: 500, hotspots: 250, badges: 100, packages: 5000, usage: 1000, files: 20})
const PACKAGE_SOURCES = new Set(['package-lock', 'yarn-lock', 'requirements', 'venv', 'poetry-lock', 'uv-lock', 'pipfile-lock', 'go-sum', 'go-mod', 'node_modules'])

const int = (value) => Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
const bool = (value) => value === true
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value) ? value : undefined
const token = (value, max = 256) => { const valueText = text(value, max); return valueText && TOKEN.test(valueText) ? valueText : undefined }
const privacySafeText = (value, max = 256) => { const valueText = text(value, max); return valueText && !ABSOLUTE_PATH_FRAGMENT.test(valueText) ? valueText : undefined }
const packageName = (value) => { const valueText = text(value, 256); return valueText && PACKAGE.test(valueText) ? valueText : undefined }
const state = (value) => STATES.has(value) ? value : 'ERROR'
const verdict = (value) => VERDICTS.has(value) ? value : 'UNKNOWN'
const compare = (a, b) => String(a).localeCompare(String(b), 'en')

function path(value, max = 4096) {
    const raw = text(value, max)
    if (!raw) return undefined
    const normalized = raw.replace(/\\/g, '/')
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(normalized)) return undefined
    const parts = normalized.split('/')
    return parts.length && parts.every((part) => part && part !== '.' && part !== '..') ? normalized : undefined
}

function graphId(value) {
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

function moduleId(value) { return value === '(root)' ? value : path(value) }
function set(out, key, value) { if (value !== undefined) out[key] = value }

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    return JSON.stringify(value)
}

function list(values, cap, mapper, sorter) {
    const all = (Array.isArray(values) ? values : []).map(mapper).filter(Boolean).sort(sorter)
    return {items: all.slice(0, cap), total: all.length, truncated: all.length > cap}
}

function count(value, fallbackTotal, returned) {
    return {
        total: Math.max(int(value?.total), fallbackTotal),
        returned,
        truncated: bool(value?.truncated) || fallbackTotal > returned,
    }
}

function reasons(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => token(value, 96)).filter(Boolean))].sort(compare).slice(0, 32)
}

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

function moduleFact(value) {
    const id = moduleId(value?.id || value?.name)
    return id ? {id, fileCount: int(value.fileCount), nodeCount: int(value.nodeCount), symbolCount: int(value.symbolCount)} : null
}

function dependency(value) {
    const from = moduleId(value?.from), to = moduleId(value?.to)
    return from && to && from !== to ? {from, to, count: int(value.count)} : null
}

function cycleFact(value) {
    const id = text(value?.id, 64), kind = value?.kind
    if (!id || !/^[a-f0-9]{16,64}$/i.test(id) || !['runtime', 'compile-time'].includes(kind)) return null
    const members = [...new Set((value.members || []).map((item) => path(item)).filter(Boolean))].sort(compare).slice(0, 200)
    const representativePath = (value.representativePath || []).map((item) => path(item)).filter(Boolean).slice(0, 201)
    if (members.length < 2 || representativePath.length < 2) return null
    return {id, kind, size: Math.max(int(value.size), members.length), members, membersTruncated: bool(value.membersTruncated) || int(value.size) > members.length, representativePath}
}

function boundaryFact(value) {
    const ruleId = token(value?.ruleId, 96), from = path(value?.from), to = path(value?.to)
    if (!ruleId || !from || !to || !['forbidden', 'allowedOnly'].includes(value?.kind) || !SEVERITIES.has(value?.severity)) return null
    return {kind: value.kind, ruleId, severity: value.severity, from, to}
}

function sanitizeArchitecture(value) {
    const modules = list(value?.modules, CAPS.modules, moduleFact, (a, b) => compare(a.id, b.id))
    const dependencies = {}
    let truncated = modules.truncated
    const dependencyMeta = {}
    for (const kind of ['runtime', 'typeOnly', 'compileOnly']) {
        const result = list(value?.dependencies?.[kind], CAPS.dependencies, dependency, (a, b) => compare(a.from, b.from) || compare(a.to, b.to))
        dependencies[kind] = result.items
        const completenessKey = `${kind}Dependencies`
        dependencyMeta[completenessKey] = count(value?.completeness?.[completenessKey], result.total, result.items.length)
        truncated ||= result.truncated
    }
    const cycles = list(value?.cycles, CAPS.findings, cycleFact, (a, b) => compare(a.kind, b.kind) || b.size - a.size || compare(a.id, b.id))
    const boundaries = list(value?.boundaryViolations, CAPS.findings, boundaryFact, (a, b) => compare(a.ruleId, b.ruleId) || compare(a.from, b.from) || compare(a.to, b.to))
    truncated ||= cycles.truncated || boundaries.truncated
    const outState = state(value?.state)
    return {
        state: truncated && outState === 'COMPLETE' ? 'PARTIAL' : outState,
        verdict: verdict(value?.verdict),
        completeness: {modules: count(value?.completeness?.modules, modules.total, modules.items.length), ...dependencyMeta, cycles: count(value?.completeness?.cycles, cycles.total, cycles.items.length), boundaryViolations: count(value?.completeness?.boundaryViolations, boundaries.total, boundaries.items.length), reasons: reasons(value?.completeness?.reasons)},
        modules: modules.items, dependencies, cycles: cycles.items, boundaryViolations: boundaries.items,
        boundaryRulesState: state(value?.boundaryRulesState),
    }
}

function numericRecord(value, keys) { const out = {}; for (const key of keys) out[key] = int(value?.[key]); return out }
function checks(value) { const out = {}; for (const key of CHECK_KEYS) out[key] = state(value?.[key]); return out }

function hotspot(value) {
    const id = graphId(value?.id), file = path(value?.file), severity = token(value?.severity, 16)
    if (!id || !file || !['medium', 'high'].includes(severity)) return null
    const out = {id, file, severity, breaches: [...new Set((value.breaches || []).map((item) => token(item, 48)).filter(Boolean))].sort(compare).slice(0, 12)}
    set(out, 'symbol', privacySafeText(value.symbol)); for (const key of ['startLine', 'endLine', 'loc', 'cyclomatic', 'params']) if (Number.isFinite(value[key]) && value[key] >= 0) out[key] = Math.trunc(value[key])
    return out
}

function sanitizeHealth(value) {
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

function sanitizeTechnologies(value) {
    const badges = list(value?.badges, CAPS.badges, badge, (a, b) => compare(a.category, b.category) || compare(a.id, b.id))
    const outState = state(value?.state)
    return {state: badges.truncated && outState === 'COMPLETE' ? 'PARTIAL' : outState, verdict: verdict(value?.verdict), completeness: {badges: count(value?.completeness?.badges, badges.total, badges.items.length), reasons: reasons(value?.completeness?.reasons)}, badges: badges.items}
}

function packageSource(value) {
    const source = text(value, 512)
    if (PACKAGE_SOURCES.has(source)) return source
    const relative = path(source, 512)
    return relative && /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|requirements[\w.-]*\.(?:txt|in)|poetry\.lock|uv\.lock|Pipfile\.lock|go\.(?:mod|sum))$/i.test(relative) ? relative : undefined
}

function packageFact(value) {
    const name = packageName(value?.name), version = token(value?.version, 128), ecosystem = token(value?.ecosystem, 64), source = packageSource(value?.source)
    return name && version && ecosystem && source ? {name, version, ecosystem, dev: bool(value.dev), source} : null
}

function usage(value) {
    const name = packageName(value?.name), ecosystem = token(value?.ecosystem, 64)
    if (!name || !ecosystem) return null
    const files = [...new Set((value.files || []).map((item) => path(item)).filter(Boolean))].sort(compare)
    return {name, ecosystem, importCount: int(value.importCount), fileCount: int(value.fileCount), files: files.slice(0, CAPS.files), filesTruncated: bool(value.filesTruncated) || files.length > CAPS.files, kinds: [...new Set((value.kinds || []).map((item) => token(item, 64)).filter(Boolean))].sort(compare).slice(0, 32)}
}

function sanitizePackages(value) {
    const inventory = list(value?.inventory, CAPS.packages, packageFact, (a, b) => compare(a.ecosystem, b.ecosystem) || compare(a.name, b.name) || compare(a.version, b.version))
    const directUsage = list(value?.directUsage, CAPS.usage, usage, (a, b) => compare(a.ecosystem, b.ecosystem) || compare(a.name, b.name))
    const outState = state(value?.state), truncated = inventory.truncated || directUsage.truncated
    return {state: truncated && outState === 'COMPLETE' ? 'PARTIAL' : outState, verdict: verdict(value?.verdict), completeness: {inventory: count(value?.completeness?.inventory, inventory.total, inventory.items.length), directUsage: count(value?.completeness?.directUsage, directUsage.total, directUsage.items.length), reasons: reasons(value?.completeness?.reasons)}, checks: checks(value?.checks), inventory: inventory.items, directUsage: directUsage.items}
}

export function sanitizeEvidenceSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.evidenceSnapshotV !== 1) throw new Error('invalid evidence snapshot')
    const sections = {architecture: sanitizeArchitecture(value.sections?.architecture), health: sanitizeHealth(value.sections?.health), technologies: sanitizeTechnologies(value.sections?.technologies), packages: sanitizePackages(value.sections?.packages)}
    const states = Object.values(sections).map((section) => section.state)
    const snapshotState = states.every((item) => item === 'ERROR') ? 'ERROR' : states.every((item) => item === 'COMPLETE' || item === 'NOT_APPLICABLE') ? 'COMPLETE' : 'PARTIAL'
    const snapshot = {evidenceSnapshotV: 1, state: snapshotState, sections}
    return {...snapshot, snapshotHash: createHash('sha256').update(stableStringify(snapshot)).digest('hex')}
}
