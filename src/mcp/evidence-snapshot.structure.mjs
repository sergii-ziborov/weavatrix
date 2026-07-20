import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {buildFileImportGraph, checkBoundaries, findSccs, isRustModuleTreeComponent, representativeCycle} from '../analysis/dep-rules.js'
import {createRepoBoundary} from '../repo-path.js'
import {CAPS, bounded, compareText, repoRelativePath, safeToken} from './evidence-snapshot.common.mjs'

const MAX_CYCLE_MEMBERS = 200
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info'])
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24)

function sortedSccs(adjacency) {
    return findSccs(adjacency)
        .map((members) => members.map((member) => repoRelativePath(member)).filter(Boolean).sort(compareText))
        .filter((members) => members.length > 1)
        .sort((a, b) => b.length - a.length || compareText(a.join('\0'), b.join('\0')))
}

function cycleFact(kind, adjacency, members) {
    const representative = representativeCycle(adjacency, members).map((member) => repoRelativePath(member)).filter(Boolean)
    return {
        id: hash(`${kind}\0${members.join('\0')}`),
        kind,
        size: members.length,
        members: members.slice(0, MAX_CYCLE_MEMBERS),
        membersTruncated: members.length > MAX_CYCLE_MEMBERS,
        representativePath: representative.slice(0, MAX_CYCLE_MEMBERS + 1),
    }
}

function readRules(repoRoot) {
    try {
        const boundary = createRepoBoundary(repoRoot)
        const resolved = boundary.resolve('.weavatrix-deps.json')
        if (!resolved.ok) return {rules: {}, state: 'NOT_APPLICABLE'}
        const parsed = JSON.parse(readFileSync(resolved.path, 'utf8'))
        const hasRules = Array.isArray(parsed?.forbidden) && parsed.forbidden.length > 0 ||
            Array.isArray(parsed?.allowedOnly) && parsed.allowedOnly.length > 0
        return {rules: parsed && typeof parsed === 'object' ? parsed : {}, state: hasRules ? 'COMPLETE' : 'NOT_APPLICABLE'}
    } catch {
        return {rules: {}, state: 'ERROR'}
    }
}

function boundaryFact(value) {
    const from = repoRelativePath(value?.from), to = repoRelativePath(value?.to)
    if (!from || !to || !['forbidden', 'allowedOnly'].includes(value?.kind)) return null
    const name = safeToken(value?.name, 96)
    return {
        kind: value.kind,
        ruleId: name || hash(String(value?.name || 'unnamed-rule')),
        severity: SEVERITIES.has(value?.severity) ? value.severity : 'medium',
        from,
        to,
    }
}

export function buildStructureEvidence(graph, repoRoot) {
    try {
        const imports = buildFileImportGraph(graph)
        const runtimeSccs = sortedSccs(imports.runtimeAdj)
        const runtimeKeys = new Set(runtimeSccs.map((members) => members.join('\0')))
        // Same suppression as computeStructureFindings: a synced snapshot must not contradict the
        // local structure findings on idiomatic Rust module trees.
        const compileSccs = sortedSccs(imports.allAdj)
            .filter((members) => !runtimeKeys.has(members.join('\0')) && !isRustModuleTreeComponent(members))
        const allCycles = [
            ...runtimeSccs.map((members) => cycleFact('runtime', imports.runtimeAdj, members)),
            ...compileSccs.map((members) => cycleFact('compile-time', imports.allAdj, members)),
        ].sort((a, b) => a.kind === b.kind ? b.size - a.size || compareText(a.id, b.id) : a.kind === 'runtime' ? -1 : 1)
        const cycles = bounded(allCycles, CAPS.architectureFindings)
        const rules = readRules(repoRoot)
        const allBoundaries = checkBoundaries(imports.runtimeEdges, rules.rules)
            .map(boundaryFact).filter(Boolean)
            .sort((a, b) => compareText(a.ruleId, b.ruleId) || compareText(a.from, b.from) || compareText(a.to, b.to))
        const boundaries = bounded(allBoundaries, CAPS.architectureFindings)
        return {state: 'COMPLETE', rulesState: rules.state, cycles, boundaries}
    } catch {
        return {
            state: 'ERROR', rulesState: 'ERROR',
            cycles: {items: [], completeness: {total: 0, returned: 0, truncated: false}},
            boundaries: {items: [], completeness: {total: 0, returned: 0, truncated: false}},
        }
    }
}
