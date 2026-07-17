import {existsSync, readFileSync, statSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {boundedInteger} from '../bounds.js'
import {atomicWriteFileSync, withFileLock} from '../graph/file-lock.js'
import {
    buildLspPrecisionOverlay,
    precisionOverlayMatches,
    precisionSemanticInputsMatch,
} from './lsp-overlay.js'

export const SYMBOL_PRECISION_CACHE_V = 1
export const SYMBOL_PRECISION_CACHE_FILE = 'precision-symbols.json'

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
