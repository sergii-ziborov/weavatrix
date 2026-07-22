// Per-symbol deletion-readiness verdict: {safe, knownReferences, unknownDynamicUsages,
// confidence, reason} plus the deletion line span as review evidence. Aggregates signals
// the repository already computes — inbound graph edges, the exact LSP point query, and
// the dead-code risk policy — into one honest verdict. safe:true is deliberately narrow:
// it requires an exact full-universe zero-reference proof AND the absence of every risk
// signal; anything weaker is "UNPROVEN", never a false clean. The decision stays
// REVIEW_REQUIRED with autoDelete:false — this is evidence, not permission (README rule).

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {isFrameworkEntryFile} from './dead-check.js'
import {hasDynamicCode, REFLECTION_CODE_RE} from './dead-code-review/policy.js'
import {querySymbolPrecision} from '../precision/symbol-query.js'

const JS_TS_FILE_RE = /\.(?:[cm]?[jt]sx?)$/i
// Edges that describe containment/shape rather than use; they never count as references.
const STRUCTURAL_TYPES = new Set(['contains', 'member_of', 'defines', 'declares'])
const MAX_REFERENCES = 200

const isPublicSurface = (node) => node?.exported === true
    || ['public', 'protected'].includes(String(node?.visibility || '').toLowerCase())

function inboundGraphReferences(rawGraph, targetId) {
    const nodesById = new Map((rawGraph.nodes || []).map((node) => [String(node?.id || ''), node]))
    const references = []
    for (const link of rawGraph.links || []) {
        if (String(link?.target || '') !== targetId) continue
        const type = String(link?.type || 'reference')
        if (STRUCTURAL_TYPES.has(type)) continue
        const source = nodesById.get(String(link?.source || ''))
        references.push({
            kind: 'GRAPH_EDGE',
            type,
            path: String(source?.source_file || String(link?.source || '').split('#')[0] || ''),
            from: String(link?.source || ''),
            ...(link?.confidence ? {provenance: String(link.confidence)} : {}),
        })
        if (references.length >= MAX_REFERENCES) break
    }
    return references
}

function sameFileOccurrences(source, name, sourceRange) {
    if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return []
    const pattern = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, '\\$&')}(?![A-Za-z0-9_$])`, 'g')
    const lines = source.split('\n')
    const startLine = Number(sourceRange?.start?.line)
    const endLine = Number(sourceRange?.end?.line)
    const occurrences = []
    for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split('\n').length - 1
        // occurrences inside the symbol's own body vanish with the deletion — not blockers
        if (Number.isInteger(startLine) && line >= startLine && line <= endLine) continue
        occurrences.push({kind: 'LEXICAL_SAME_FILE', line: line + 1, excerpt: (lines[line] || '').trim().slice(0, 120)})
    }
    return occurrences
}

async function exactEvidence({repoRoot, graphPath, targetId, node, queryPrecision, timeoutMs}) {
    const supportsLsp = JS_TS_FILE_RE.test(String(node.source_file || '')) && node.selection_start
    if (!supportsLsp || !graphPath) return {status: 'NOT_SUPPORTED_FOR_LANGUAGE', references: []}
    try {
        const {overlay} = await queryPrecision({repoRoot, graphPath, targetId, timeoutMs})
        const references = (Array.isArray(overlay?.locations) ? overlay.locations : [])
            .filter((location) => String(location?.target || '') === targetId)
            .slice(0, MAX_REFERENCES)
            .map((location) => ({kind: 'EXACT_LSP', path: String(location.file || ''), line: location.line}))
        if (references.length) return {status: 'REFERENCES_FOUND', references}
        const zeroConfirmed = overlay?.state === 'COMPLETE'
            && Array.isArray(overlay.noReferenceSymbols)
            && overlay.noReferenceSymbols.some((id) => String(id) === targetId)
        return {status: zeroConfirmed ? 'ZERO_CONFIRMED' : 'NOT_CHECKED_OR_INCOMPLETE', references: []}
    } catch (error) {
        return {status: 'NOT_CHECKED_OR_INCOMPLETE', error: error?.message, references: []}
    }
}

export async function computeDeleteReadiness({
    repoRoot,
    rawGraph,
    graphPath = null,
    targetId,
    queryPrecision = querySymbolPrecision,
    timeoutMs = 30_000,
} = {}) {
    if (!repoRoot || !rawGraph || !targetId) throw new Error('delete readiness requires repoRoot, rawGraph, and targetId')
    const id = String(targetId)
    const node = (rawGraph.nodes || []).find((candidate) => String(candidate?.id || '') === id)
    if (!node) return {status: 'NOT_FOUND', reason: 'the selected symbol is not present in the active graph'}
    const file = String(node.source_file || id.split('#')[0] || '')
    let source = ''
    try {
        source = readFileSync(resolve(repoRoot, file), 'utf8')
    } catch {
        return {status: 'SOURCE_UNAVAILABLE', reason: `${file}: file does not exist or is unreadable`}
    }

    const knownReferences = inboundGraphReferences(rawGraph, id)
    const name = String(node.label || '').replace(/\s*\(.*$/, '').trim()
    knownReferences.push(...sameFileOccurrences(source, name, node.source_range).slice(0, MAX_REFERENCES))
    const exact = await exactEvidence({repoRoot, graphPath, targetId: id, node, queryPrecision, timeoutMs})
    knownReferences.push(...exact.references)

    const publicSurface = isPublicSurface(node)
    const dynamic = hasDynamicCode(source, file)
    const reflection = REFLECTION_CODE_RE.test(source)
    const frameworkEntry = isFrameworkEntryFile(file)
    const decorated = node.decorated === true
    const zeroConfirmed = exact.status === 'ZERO_CONFIRMED'

    const unknownDynamicUsages = [
        {signal: 'EXTERNAL_CONSUMERS', status: publicSurface ? 'NOT_POSSIBLE_FROM_REPOSITORY_GRAPH' : 'NOT_APPLICABLE_INTERNAL'},
        {signal: 'DYNAMIC_LOADING', status: dynamic ? 'PRESENT' : 'NOT_OBSERVED_IN_DECLARING_FILE'},
        {signal: 'REFLECTION', status: reflection ? 'PRESENT' : 'NOT_OBSERVED_IN_DECLARING_FILE'},
        {signal: 'FRAMEWORK_ENTRY', status: frameworkEntry ? 'PRESENT' : 'NOT_OBSERVED'},
        {signal: 'DECORATOR_REGISTRATION', status: decorated ? 'PRESENT' : 'NOT_OBSERVED'},
        {signal: 'EXACT_LSP_REFERENCES', status: exact.status},
        {signal: 'REPO_WIDE_LEXICAL_SCAN', status: zeroConfirmed ? 'SUBSUMED_BY_EXACT_LSP' : 'NOT_CHECKED'},
    ]
    const blocking = unknownDynamicUsages.filter((usage) => ['PRESENT', 'NOT_POSSIBLE_FROM_REPOSITORY_GRAPH'].includes(usage.status))

    let safe
    let confidence
    let reason
    if (knownReferences.length) {
        safe = false
        confidence = 'high'
        reason = `${knownReferences.length} known reference(s) target this symbol; deleting it would break them`
    } else if (zeroConfirmed && !blocking.length) {
        safe = true
        confidence = 'high'
        reason = 'the language server confirmed zero in-workspace references over the complete project universe and no dynamic-usage risk signal is present; final review and tests remain yours'
    } else {
        safe = 'UNPROVEN'
        confidence = blocking.length ? 'low' : 'medium'
        reason = blocking.length
            ? `absence of references is not proven safe: ${blocking.map((usage) => usage.signal).join(', ')}`
            : 'no known references, but no complete exact zero-reference proof exists; static absence alone is never proof of deletion safety'
    }

    const range = node.source_range
    return {
        status: 'OK',
        symbol: name || id,
        file,
        safe,
        confidence,
        reason,
        knownReferences,
        unknownDynamicUsages,
        deletion: range?.start && range?.end
            ? {file, startLine: Number(range.start.line) + 1, endLine: Number(range.end.line) + 1}
            : {file, startLine: null, endLine: null, note: 'no source range recorded; locate the declaration manually'},
        remainingChecks: [
            ...(zeroConfirmed ? [] : ['Run an exact language-server reference query for this declaration.']),
            ...(publicSurface ? ['Check downstream/external consumers of the public API.'] : []),
            ...(dynamic ? ['Resolve dynamic import/require targets and name-based dispatch.'] : []),
            ...(reflection ? ['Inspect reflection/annotation/configuration consumers.'] : []),
            'Run the repository tests after any removal (verified_change phase=verify).',
        ],
        decision: 'REVIEW_REQUIRED',
        autoDelete: false,
    }
}
