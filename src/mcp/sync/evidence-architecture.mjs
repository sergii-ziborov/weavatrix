import {
    CAPS, SEVERITIES, bool, compare, count, int, list, moduleId, path,
    reasons, state, text, token, verdict,
} from './evidence-common.mjs'

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

export function sanitizeArchitecture(value) {
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
