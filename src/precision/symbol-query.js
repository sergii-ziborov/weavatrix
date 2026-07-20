import {existsSync, readFileSync, statSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {boundedInteger} from '../bounds.js'
import {atomicWriteFileSync, withFileLock} from '../graph/file-lock.js'
import {
    buildLspPrecisionOverlay,
    precisionOverlayMatches,
    precisionSemanticInputsMatch,
} from './lsp-overlay.js'
import {createPathClassifier, hasPathClass} from '../path-classification.js'

const SYMBOL_PRECISION_CACHE_V = 1
const SYMBOL_PRECISION_CACHE_FILE = 'precision-symbols.json'

const MAX_CACHE_ENTRIES = 32
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_CACHE_READ_BYTES = 16 * 1024 * 1024
const inFlight = new Map()

export function symbolPrecisionCachePath(graphPath) {
    return resolve(dirname(graphPath), SYMBOL_PRECISION_CACHE_FILE)
}

function loadRawGraph(graphPath) {
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
        throw new Error('the active graph is not a valid Weavatrix graph')
    }
    return graph
}

function emptyCache() {
    return {symbolPrecisionCacheV: SYMBOL_PRECISION_CACHE_V, entries: []}
}

function readCache(path) {
    if (!existsSync(path)) return emptyCache()
    try {
        if (statSync(path).size > MAX_CACHE_READ_BYTES) return emptyCache()
        const value = JSON.parse(readFileSync(path, 'utf8'))
        if (Number(value?.symbolPrecisionCacheV) !== SYMBOL_PRECISION_CACHE_V || !Array.isArray(value.entries)) return emptyCache()
        return {symbolPrecisionCacheV: SYMBOL_PRECISION_CACHE_V, entries: value.entries.slice(0, MAX_CACHE_ENTRIES)}
    } catch {
        return emptyCache()
    }
}

function writeBoundedCache(path, entries) {
    const kept = entries
        .filter((entry) => entry && typeof entry === 'object')
        .sort((left, right) => Number(right.usedAt) - Number(left.usedAt))
        .slice(0, MAX_CACHE_ENTRIES)
    let body
    do {
        body = JSON.stringify({symbolPrecisionCacheV: SYMBOL_PRECISION_CACHE_V, entries: kept})
        if (Buffer.byteLength(body) <= MAX_CACHE_BYTES || !kept.length) break
        kept.pop()
    } while (true)
    atomicWriteFileSync(path, body, 'utf8')
}

function cacheMatch(entry, {targetId, graph, repoRoot, request}) {
    if (String(entry?.targetId || '') !== targetId || !entry.overlay) return false
    if (!precisionOverlayMatches(entry.overlay, graph, {request})) return false
    return precisionSemanticInputsMatch(entry.overlay, repoRoot, graph)
}

async function storeEntry(path, entry) {
    await withFileLock(`${path}.lock`, async () => {
        const current = readCache(path)
        const entries = current.entries.filter((item) => String(item?.targetId || '') !== entry.targetId)
        entries.unshift(entry)
        writeBoundedCache(path, entries)
    })
}

function cacheable(overlay) {
    if (overlay?.state === 'COMPLETE') return true
    return overlay?.state === 'PARTIAL'
        && overlay?.reason === 'semantic precision stopped at a configured safety limit'
}

// Point-query results intentionally live outside the broad precision overlay. Health tools still
// need to consume revision-bound positive evidence: once an exact query found a reference, the
// same symbol must not remain in a dead-code queue. This reader is synchronous and fail-closed;
// stale, malformed, incomplete no-reference, or semantically changed entries contribute nothing.
export function readCachedSymbolPrecisionEvidence({repoRoot, graphPath, graph} = {}) {
    const empty = {referenceSymbols: [], productionReferenceSymbols: [], testReferenceSymbols: [], noReferenceSymbols: []}
    if (!repoRoot || !graphPath || !graph) return empty
    const precisionGraph = graph.graphPrecisionMode === 'off' ? {...graph, graphPrecisionMode: 'lsp'} : graph
    const nodesById = new Map((precisionGraph.nodes || []).map((node) => [String(node.id), node]))
    const classifier = createPathClassifier(repoRoot)
    const referenced = new Set()
    const production = new Set()
    const tests = new Set()
    const noReference = new Set()
    const semanticMatches = new Map()
    for (const entry of readCache(symbolPrecisionCachePath(graphPath)).entries) {
        const overlay = entry?.overlay
        if (!overlay || !precisionOverlayMatches(overlay, precisionGraph, {request: overlay.request})) continue
        const fingerprint = String(overlay.semanticInputFingerprint || '')
        if (!semanticMatches.has(fingerprint)) semanticMatches.set(
            fingerprint,
            precisionSemanticInputsMatch(overlay, repoRoot, precisionGraph),
        )
        if (!semanticMatches.get(fingerprint)) continue
        const targetId = String(entry.targetId || '')
        if (!nodesById.has(targetId)) continue
        const locations = Array.isArray(overlay.locations)
            ? overlay.locations.filter((location) => String(location?.target || '') === targetId)
            : []
        if (locations.length) {
            referenced.add(targetId)
            for (const location of locations) {
                const file = String(location?.file || nodesById.get(String(location?.source || ''))?.source_file || '')
                if (!file) continue
                const info = classifier.explain(file, {content: ''})
                if (hasPathClass(info, 'test', 'e2e')) tests.add(targetId)
                else production.add(targetId)
            }
        }
        if (overlay.state === 'COMPLETE' && Array.isArray(overlay.noReferenceSymbols)
            && overlay.noReferenceSymbols.some((id) => String(id) === targetId)) noReference.add(targetId)
    }
    return {
        referenceSymbols: [...referenced],
        productionReferenceSymbols: [...production],
        testReferenceSymbols: [...tests],
        noReferenceSymbols: [...noReference],
    }
}

export async function querySymbolPrecision({
    repoRoot,
    graphPath,
    targetId,
    maxReferences = 1_000,
    timeoutMs = 30_000,
    clientFactory,
} = {}) {
    if (!repoRoot || !graphPath || !targetId) throw new Error('symbol precision requires repoRoot, graphPath, and targetId')
    const boundedReferences = boundedInteger(maxReferences, 1_000, 1, 5_000)
    const boundedTimeout = boundedInteger(timeoutMs, 30_000, 1_000, 60_000)
    const request = {maxSymbols: 1, maxReferences: boundedReferences, maxLinks: boundedReferences}
    const rawGraph = loadRawGraph(graphPath)
    const graph = rawGraph.graphPrecisionMode === 'off' ? {...rawGraph, graphPrecisionMode: 'lsp'} : rawGraph
    const target = graph.nodes.find((node) => String(node?.id || '') === String(targetId))
    if (!target) throw new Error('the selected symbol is not present in the active raw graph')
    if (!target.selection_start || !/\.(?:[cm]?[jt]sx?)$/i.test(String(target.source_file || ''))) {
        throw new Error('exact symbol precision currently supports JavaScript and TypeScript symbols with source selections')
    }

    const id = String(targetId)
    const cachePath = symbolPrecisionCachePath(graphPath)
    const startedAt = Date.now()
    const cached = readCache(cachePath).entries.find((entry) => cacheMatch(entry, {targetId: id, graph, repoRoot, request}))
    if (cached) return {overlay: cached.overlay, cached: true, elapsedMs: Date.now() - startedAt, cachePath}

    const flightKey = `${graphPath}\0${graph.graphRevision || ''}\0${id}\0${boundedReferences}`
    if (inFlight.has(flightKey)) return inFlight.get(flightKey)
    const operation = (async () => {
        const overlay = await buildLspPrecisionOverlay({
            repoRoot,
            graph,
            mode: 'lsp',
            maxSymbols: 1,
            maxReferences: boundedReferences,
            maxLinks: boundedReferences,
            timeoutMs: boundedTimeout,
            targetIds: [id],
            clientFactory,
        })
        if (cacheable(overlay)) {
            await storeEntry(cachePath, {targetId: id, usedAt: Date.now(), overlay})
        }
        return {overlay, cached: false, elapsedMs: Date.now() - startedAt, cachePath}
    })()
    inFlight.set(flightKey, operation)
    try {
        return await operation
    } finally {
        inFlight.delete(flightKey)
    }
}

export async function querySymbolsPrecision({
    repoRoot,
    graphPath,
    targetIds,
    maxReferences = 5_000,
    timeoutMs = 45_000,
    clientFactory,
} = {}) {
    if (!repoRoot || !graphPath || !Array.isArray(targetIds) || !targetIds.length) {
        throw new Error('batch symbol precision requires repoRoot, graphPath, and targetIds')
    }
    const ids = [...new Set(targetIds.map(String).filter(Boolean))].slice(0, 16)
    const boundedReferences = boundedInteger(maxReferences, 5_000, 1, 16_384)
    const boundedTimeout = boundedInteger(timeoutMs, 45_000, 1_000, 60_000)
    const rawGraph = loadRawGraph(graphPath)
    const graph = rawGraph.graphPrecisionMode === 'off' ? {...rawGraph, graphPrecisionMode: 'lsp'} : rawGraph
    const nodes = new Map((graph.nodes || []).map((node) => [String(node?.id || ''), node]))
    for (const id of ids) {
        const target = nodes.get(id)
        if (!target) throw new Error(`precision target is absent from the active graph: ${id}`)
        if (!target.selection_start || !/\.(?:[cm]?[jt]sx?)$/i.test(String(target.source_file || ''))) {
            throw new Error(`exact batch precision does not support target: ${id}`)
        }
    }
    const startedAt = Date.now()
    const overlay = await buildLspPrecisionOverlay({
        repoRoot,
        graph,
        mode: 'lsp',
        maxSymbols: ids.length,
        maxReferences: boundedReferences,
        maxLinks: boundedReferences,
        timeoutMs: boundedTimeout,
        targetIds: ids,
        clientFactory,
    })
    return {overlay, targetIds: ids, elapsedMs: Date.now() - startedAt}
}
