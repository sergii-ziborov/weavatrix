import {readFileSync, statSync} from 'node:fs'
import {resolveRepoPath} from '../repo-path.js'
import {isStructuralRelation} from '../graph/relations.js'
import {querySymbolPrecision} from '../precision/symbol-query.js'
import {toolResult} from './tool-result.mjs'
import {degreeOf, isSymbol, labelOf, resolveNodeInfo} from './graph-context.mjs'

const MAX_EXCERPT_CHARS = 4_000
const MAX_LOCATION_SAMPLES = 5
const MAX_GRAPH_OCCURRENCES = 100

const boundedInteger = (value, fallback, minimum, maximum) => {
    const number = Number(value)
    return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? Math.floor(number) : fallback))
}

const sourceLine = (node) => {
    const match = /L(\d+)/.exec(String(node?.source_location || ''))
    return match ? Number(match[1]) : 1
}

function candidateNodes(g, query, limit = 20) {
    const text = String(query || '').trim().toLowerCase()
    if (!text) return []
    const exact = g.byLabel.get(text)
    const nodes = exact?.length ? exact : g.nodes.filter((node) =>
        String(node.id).toLowerCase().includes(text) || String(node.label || '').toLowerCase().includes(text))
    return nodes.slice(0, limit).map((node) => ({id: String(node.id), label: String(node.label || node.id), file: node.source_file || null}))
}

function excerpt(repoRoot, file, focusLine, contextLines) {
    const resolved = resolveRepoPath(repoRoot, file)
    if (!resolved.ok) return null
    let size
    try { size = statSync(resolved.path).size } catch { return null }
    if (size > 2 * 1024 * 1024) return null
    let lines
    try { lines = readFileSync(resolved.path, 'utf8').split(/\r?\n/) } catch { return null }
    const focus = Math.max(1, Math.min(lines.length, Number(focusLine) || 1))
    const startLine = Math.max(1, focus - contextLines)
    const endLine = Math.min(lines.length, focus + contextLines)
    const rawText = lines.slice(startLine - 1, endLine).join('\n')
    return {
        file,
        focusLine: focus,
        startLine,
        endLine,
        text: rawText.length > MAX_EXCERPT_CHARS ? `${rawText.slice(0, MAX_EXCERPT_CHARS)}\n… [excerpt truncated]` : rawText,
        truncated: rawText.length > MAX_EXCERPT_CHARS,
    }
}

function reverseImpact(g, targetId, depth = 3, cap = 40) {
    const seen = new Map([[targetId, 0]])
    const queue = [targetId]
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor]
        const currentDepth = seen.get(current)
        if (currentDepth >= depth) continue
        for (const edge of g.inn.get(current) || []) {
            if (isStructuralRelation(edge.relation) || edge.barrelProxy === true) continue
            const id = String(edge.id)
            if (seen.has(id)) continue
            seen.set(id, currentDepth + 1)
            queue.push(id)
        }
    }
    return [...seen.entries()]
        .filter(([id]) => id !== targetId)
        .map(([id, distance]) => ({id, label: labelOf(g, id), distance, degree: degreeOf(g, id)}))
        .sort((left, right) => left.distance - right.distance || right.degree - left.degree)
        .slice(0, cap)
}

function graphOccurrences(g, targetId) {
    const all = (g.inn.get(targetId) || [])
        .filter((edge) => !isStructuralRelation(edge.relation) && edge.barrelProxy !== true)
        .map((edge) => ({
            source: String(edge.id),
            label: labelOf(g, edge.id),
            relation: edge.relation || 'references',
            provenance: edge.provenance || 'UNKNOWN',
            ...(Number.isInteger(edge.line) ? {line: edge.line} : {}),
            ...(edge.typeOnly === true ? {typeOnly: true} : {}),
            ...(edge.compileOnly === true ? {compileOnly: true} : {}),
        }))
    return {total: all.length, shown: all.slice(0, MAX_GRAPH_OCCURRENCES)}
}

function groupLocations(g, locations, cap) {
    const groups = new Map()
    for (const location of locations) {
        const source = String(location.source || location.file || '')
        if (!source) continue
        const node = g.byId.get(source)
        const file = String(location.file || node?.source_file || (isSymbol(source) ? source.split('#')[0] : source))
        let group = groups.get(source)
        if (!group) {
            group = {id: source, label: String(node?.label || source), file, count: 0, classifications: {}, locations: []}
            groups.set(source, group)
        }
        group.count++
        const classification = String(location.classification || 'unknown')
        group.classifications[classification] = (group.classifications[classification] || 0) + 1
        if (group.locations.length < MAX_LOCATION_SAMPLES) group.locations.push({
          line: location.line,
          character: location.character,
          ...(Number.isInteger(location.endLine) ? {endLine: location.endLine} : {}),
          ...(Number.isInteger(location.endCharacter) ? {endCharacter: location.endCharacter} : {}),
          classification,
        })
    }
    const all = [...groups.values()].sort((left, right) => right.count - left.count || left.file.localeCompare(right.file) || left.id.localeCompare(right.id))
    return {all, shown: all.slice(0, cap)}
}

function textFor(result) {
    if (result.status === 'NOT_FOUND') return `No symbol found matching "${result.query}".`
    if (result.status === 'AMBIGUOUS') return [
        `Symbol "${result.query}" is ambiguous (${result.candidates.length} candidate(s) shown). Supply an exact node ID:`,
        ...result.candidates.map((candidate) => `  ${candidate.label}  [${candidate.id}]`),
    ].join('\n')
    const definition = result.definition
    const lines = [
        `Symbol inspection: ${definition.label}  [${definition.id}]`,
        `Definition: ${definition.file}:${definition.line}`,
        `Evidence: ${result.evidence.state}${result.evidence.cached ? ' (cache hit)' : ''}; ${result.exact.occurrences} exact reference occurrence(s) in ${result.exact.files} file(s) / ${result.exact.containers} container(s).`,
        `Graph: ${result.graph.occurrenceTotal} direct occurrence edge(s) (${result.graph.occurrences.length} shown); ${result.graph.impact.length} dependent(s) shown.`,
    ]
    if (result.evidence.reason) lines.push(`Completeness: ${result.evidence.reason}`)
    if (result.exact.zeroReferences) lines.push('Exact result: zero non-declaration references in the completely covered project universe.')
    if (result.exact.groups.length) {
        lines.push('Reference containers:')
        for (const group of result.exact.groups) lines.push(`  ${group.count} site(s)  ${group.label}  [${group.id}]`)
    }
    if (result.source.definition) {
        const source = result.source.definition
        lines.push('', `Definition source (${source.file}:${source.startLine}-${source.endLine}):`, source.text)
    }
    for (const source of result.source.callers) {
        lines.push('', `Caller source (${source.file}:${source.startLine}-${source.endLine}, focus ${source.focusLine}):`, source.text)
    }
    return lines.join('\n')
}

export async function tInspectSymbol(g, args = {}, ctx = {}) {
    const query = String(args.label || '').trim()
    const info = resolveNodeInfo(g, query)
    if (!info.node) return toolResult(textFor({status: 'NOT_FOUND', query}), {status: 'NOT_FOUND', query})
    if (info.matches > 1 && !g.byId.has(query)) {
        const result = {status: 'AMBIGUOUS', query, candidates: candidateNodes(g, query)}
        return toolResult(textFor(result), result, {completeness: {status: 'blocked', reason: 'ambiguous symbol'}})
    }
    const node = info.node
    const targetId = String(node.id)
    if (!isSymbol(targetId)) {
        const result = {status: 'UNSUPPORTED', query, candidates: [{id: targetId, label: node.label || targetId, file: node.source_file || targetId}]}
        return toolResult('inspect_symbol requires a symbol node, not a file node.', result)
    }
    const maxReferences = boundedInteger(args.max_references, 1_000, 1, 5_000)
    const maxContainers = boundedInteger(args.max_containers, 15, 1, 50)
    const contextLines = boundedInteger(args.context_lines, 8, 0, 40)
    const timeoutMs = boundedInteger(args.timeout_ms, 30_000, 1_000, 60_000)
    const precision = ['auto', 'graph', 'lsp'].includes(args.precision) ? args.precision : 'auto'
    const shouldQuery = precision === 'lsp' || (precision === 'auto' && g.graphPrecisionMode !== 'off')
    let overlay = null
    let cached = false
    let elapsedMs = 0
    let queryError = null
    if (shouldQuery) {
        try {
            const queryResult = await querySymbolPrecision({repoRoot: ctx.repoRoot, graphPath: ctx.graphPath, targetId, maxReferences, timeoutMs})
            overlay = queryResult.overlay
            cached = queryResult.cached
            elapsedMs = queryResult.elapsedMs
        } catch (error) {
            queryError = error?.message || 'exact symbol query failed'
        }
    }
    const locations = Array.isArray(overlay?.locations) ? overlay.locations : []
    const grouped = groupLocations(g, locations, maxContainers)
    const files = new Set(locations.map((location) => String(location.file || '')).filter(Boolean))
    let state = 'GRAPH_ONLY'
    if (overlay?.state === 'COMPLETE') state = 'EXACT'
    else if (overlay?.state === 'PARTIAL') state = 'PARTIAL'
    else if (overlay?.state === 'OFF') state = 'OFF'
    else if (shouldQuery) state = 'UNAVAILABLE'
    const reason = queryError || overlay?.reason || (shouldQuery ? null : 'semantic precision was not requested')
    const graphRefs = graphOccurrences(g, targetId)
    const impact = reverseImpact(g, targetId)
    const definition = {
        id: targetId,
        label: String(node.label || targetId),
        kind: String(node.symbol_kind || 'symbol'),
        file: String(node.source_file || targetId.split('#')[0]),
        line: sourceLine(node),
        ...(node.source_range ? {range: node.source_range} : {}),
        ...(node.complexity ? {complexity: node.complexity} : {}),
    }
    const definitionSource = excerpt(ctx.repoRoot, definition.file, definition.line, contextLines)
    const callerSources = grouped.shown.slice(0, 5).map((group) => excerpt(ctx.repoRoot, group.file, group.locations[0]?.line || 1, contextLines)).filter(Boolean)
    const result = {
        status: 'OK',
        definition,
        evidence: {state, cached, elapsedMs, reason, provider: overlay?.engines?.[0]?.provider || null},
        exact: {
            occurrences: locations.length,
            occurrencesWithDefinition: locations.length + 1,
            files: files.size,
            containers: grouped.all.length,
            groups: grouped.shown,
            zeroReferences: overlay?.noReferenceSymbols?.includes(targetId) === true,
            capped: overlay?.coverage?.truncated === true || grouped.all.length > grouped.shown.length,
        },
        graph: {
            occurrences: graphRefs.shown,
            occurrenceTotal: graphRefs.total,
            occurrencesCapped: graphRefs.total > graphRefs.shown.length,
            impact,
        },
        source: {definition: definitionSource, callers: callerSources},
    }
    const warnings = state === 'PARTIAL' || state === 'UNAVAILABLE'
        ? [{code: 'SYMBOL_PRECISION_INCOMPLETE', message: reason || `semantic precision is ${state.toLowerCase()}`}]
        : []
    return toolResult(textFor(result), result, {
        warnings,
        completeness: {
            status: state === 'EXACT' && !result.exact.capped ? 'complete' : state.toLowerCase(),
            referenceLimit: maxReferences,
            containerLimit: maxContainers,
            returnedContainers: grouped.shown.length,
            locationSamplesPerContainer: MAX_LOCATION_SAMPLES,
            graphOccurrenceLimit: MAX_GRAPH_OCCURRENCES,
        },
    })
}
