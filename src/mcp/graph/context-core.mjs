import {readFileSync} from 'node:fs'
import {isStructuralRelation} from '../../graph/relations.js'
import {edgeProvenance} from '../../graph/edge-provenance.js'
import {mergePrecisionOverlay, precisionSemanticInputsMatch, readPrecisionOverlay} from '../../precision/lsp-overlay.js'

export function loadGraph(path, {repoRoot = null} = {}) {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    const overlay = readPrecisionOverlay(path, saved)
    const safeOverlay = repoRoot && typeof overlay?.semanticInputFingerprint === 'string'
        && !precisionSemanticInputsMatch(overlay, repoRoot, saved) ? null : overlay
    const raw = mergePrecisionOverlay(saved, safeOverlay)
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
    const links = Array.isArray(raw.links) ? raw.links : []
    const byId = new Map()
    const byLabel = new Map()
    for (const n of nodes) {
        if (!n || n.id == null) continue
        byId.set(String(n.id), n)
        const key = String(n.label ?? n.id).toLowerCase()
        if (!byLabel.has(key)) byLabel.set(key, [])
        byLabel.get(key).push(n)
    }
    const out = new Map()
    const inn = new Map()
    const push = (map, k, v) => {
        if (!map.has(k)) map.set(k, [])
        map.get(k).push(v)
    }
    for (const e of links) {
        if (!e || e.source == null || e.target == null) continue
        const s = String(e.source), t = String(e.target)
        const metadata = {
            relation: e.relation,
            confidence: e.confidence,
            provenance: edgeProvenance(e),
            ...(e.typeOnly === true ? {typeOnly: true} : {}),
            ...(e.compileOnly === true ? {compileOnly: true} : {}),
            ...(Number.isInteger(e.line) ? {line: e.line} : {}),
            ...(typeof e.specifier === 'string' ? {specifier: e.specifier} : {}),
            ...(e.barrelProxy === true ? {barrelProxy: true} : {}),
            ...(e.semanticOrigin === true ? {semanticOrigin: true} : {}),
            ...(typeof e.viaBarrel === 'string' ? {viaBarrel: e.viaBarrel} : {}),
        }
        push(out, s, {id: t, ...metadata})
        push(inn, t, {id: s, ...metadata})
    }
    return {
        nodes, links, byId, byLabel, out, inn,
        repoBoundaryV: Number(raw.repoBoundaryV) || 0,
        edgeTypesV: Number(raw.edgeTypesV) || 0,
        edgeProvenanceV: Number(raw.edgeProvenanceV) || 0,
        barrelResolutionV: Number(raw.barrelResolutionV) || 0,
        reExportOccurrencesV: Number(raw.reExportOccurrencesV) || 0,
        symbolSpacesV: Number(raw.symbolSpacesV) || 0,
        reExportOccurrences: Array.isArray(raw.reExportOccurrences) ? raw.reExportOccurrences : [],
        jsExportRecords: raw.jsExportRecords && typeof raw.jsExportRecords === 'object' ? raw.jsExportRecords : {},
        extractorSchemaV: Number(raw.extractorSchemaV) || 0,
        extImportsV: Number(raw.extImportsV) || 0,
        complexityV: Number(raw.complexityV) || 0,
        graphBuildMode: ['full', 'no-tests', 'tests-only'].includes(raw.graphBuildMode) ? raw.graphBuildMode : 'full',
        graphBuildScope: typeof raw.graphBuildScope === 'string' ? raw.graphBuildScope : null,
        graphRevision: typeof raw.graphRevision === 'string' ? raw.graphRevision : null,
        repositoryFreshnessProbeV: Number(raw.repositoryFreshnessProbeV) || 0,
        repositoryFreshnessBuilderSchemaV: Number(raw.repositoryFreshnessBuilderSchemaV) || 0,
        repositoryFreshnessBuilderVersion: typeof raw.repositoryFreshnessBuilderVersion === 'string' ? raw.repositoryFreshnessBuilderVersion : null,
        repositoryFreshnessProbe: typeof raw.repositoryFreshnessProbe === 'string' ? raw.repositoryFreshnessProbe : null,
        repositoryFreshnessMode: typeof raw.repositoryFreshnessMode === 'string' ? raw.repositoryFreshnessMode : null,
        graphPrecisionMode: raw.graphPrecisionMode === 'off' ? 'off' : 'lsp',
        precisionOverlayV: Number(raw.precisionOverlayV) || 0,
        precision: raw.precision || null,
    }
}

export const isSymbol = (id) => String(id).includes('#')
export const labelOf = (g, id) => {
    const n = g.byId.get(String(id))
    return n ? String(n.label ?? n.id) : String(id)
}
export const connList = (list) => (list || []).filter((e) => !isStructuralRelation(e.relation) && e.barrelProxy !== true)
export const degreeOf = (g, id) => connList(g.out.get(id)).length + connList(g.inn.get(id)).length
export const uniqueConnCount = (list) => new Set(connList(list).map((e) => String(e.id))).size

export function resolveNodeInfo(g, query) {
    const q = String(query ?? '').trim()
    if (!q) return {node: null, matches: 0, alternates: []}
    if (g.byId.has(q)) return {node: g.byId.get(q), matches: 1, alternates: []}
    const exactLabel = g.byLabel.get(q.toLowerCase())
    if (exactLabel?.length) return pickBest(g, exactLabel)
    const hits = []
    for (const n of g.nodes) {
        if (String(n.id).toLowerCase().includes(q.toLowerCase()) || String(n.label ?? '').toLowerCase().includes(q.toLowerCase())) hits.push(n)
        if (hits.length > 500) break
    }
    return hits.length ? pickBest(g, hits) : {node: null, matches: 0, alternates: []}
}

export const resolveNode = (g, query) => resolveNodeInfo(g, query).node
const bestByDegree = (g, list) => list.reduce((best, n) => (degreeOf(g, n.id) > degreeOf(g, best.id) ? n : best), list[0])
function pickBest(g, list) {
    const node = bestByDegree(g, list)
    const alternates = list.filter((n) => n !== node).sort((a, b) => degreeOf(g, b.id) - degreeOf(g, a.id))
        .slice(0, 4).map((n) => `${n.label ?? n.id} [${n.id}]`)
    return {node, matches: list.length, alternates}
}

export function ambiguityNote(query, info) {
    if (!info.node || info.matches <= 1) return null
    const more = info.matches - 1 - info.alternates.length
    return `Note: "${query}" matched ${info.matches} nodes; using the best-connected. Others: ${info.alternates.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
}
