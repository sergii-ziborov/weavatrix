import {dirname} from 'node:path'
import {buildGraphForRepo, defaultPrecisionMode} from '../../build-graph.js'
import {persistedFreshnessMatches, repositoryFreshnessProbe} from '../../graph/freshness-probe.js'
import {PRECISION_OVERLAY_V, precisionSemanticInputsMatch, readPrecisionOverlay} from '../../precision/lsp-overlay.js'
import {loadGraph} from '../graph-context.mjs'

export function createAutoRefresh(getApi) {
    const probeCache = new Map()
    const configured = process.env.WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS == null
        ? 2_000 : Number(process.env.WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS)
    const debounceMs = Math.max(0, Math.min(5_000, Number.isFinite(configured) ? configured : 2_000))
    return async function autoRefresh(callCtx, currentGraph) {
        if (!callCtx?.repoRoot || !callCtx?.graphPath) return {graph: null, refresh: null}
        const activePrecision = currentGraph?.graphPrecisionMode || defaultPrecisionMode()
        const probeKey = `${callCtx.graphPath}\0${currentGraph?.graphBuildMode || 'full'}\0${activePrecision}`
        let semanticInputsChanged = false
        if (activePrecision === 'lsp' && currentGraph) {
            try {
                const overlay = readPrecisionOverlay(callCtx.graphPath, currentGraph)
                semanticInputsChanged = typeof overlay?.semanticInputFingerprint === 'string'
                    && !precisionSemanticInputsMatch(overlay, callCtx.repoRoot, currentGraph)
            } catch {
                semanticInputsChanged = true
            }
        }
        const cached = probeCache.get(probeKey)
        if (!semanticInputsChanged && currentGraph && cached && Date.now() - cached.checkedAt < debounceMs) {
            return {graph: currentGraph, refresh: {kind: 'none', revision: currentGraph.graphRevision || null, changedFiles: 0}}
        }
        const beforeProbe = repositoryFreshnessProbe(callCtx.repoRoot)
        const precisionMissing = activePrecision === 'lsp' && (
            Number(currentGraph?.precisionOverlayV) !== PRECISION_OVERLAY_V || semanticInputsChanged
        )
        if (!precisionMissing && beforeProbe && currentGraph && (
            cached?.probe === beforeProbe
            || persistedFreshnessMatches(currentGraph, beforeProbe, currentGraph.graphBuildMode || 'full')
        )) {
            probeCache.set(probeKey, {probe: beforeProbe, checkedAt: Date.now()})
            return {graph: currentGraph, refresh: {kind: 'none', revision: currentGraph.graphRevision || null, changedFiles: 0}}
        }
        const result = await buildGraphForRepo(callCtx.repoRoot, {
            mode: currentGraph?.graphBuildMode || 'full',
            precision: activePrecision,
            scope: '',
            outDir: dirname(callCtx.graphPath),
        })
        if (!result.ok) throw new Error(result.error || 'automatic graph refresh failed')
        getApi().resetStalenessCache()
        const fresh = loadGraph(callCtx.graphPath, {repoRoot: callCtx.repoRoot})
        const afterProbe = repositoryFreshnessProbe(callCtx.repoRoot)
        if (afterProbe && afterProbe === beforeProbe) probeCache.set(probeKey, {probe: afterProbe, checkedAt: Date.now()})
        else probeCache.delete(probeKey)
        const update = result.refresh || {kind: 'full', changedFiles: [], reason: 'automatic-refresh'}
        return {
            graph: fresh,
            refresh: {
                kind: update.kind,
                revision: update.revision || fresh.graphRevision || null,
                changedFiles: Array.isArray(update.changedFiles) ? update.changedFiles.length : 0,
                notice: update.kind === 'none'
                    ? undefined
                    : `Graph ${update.kind === 'incremental' ? 'incrementally refreshed' : 'rebuilt'} before this answer (${update.reason || 'repository changed'}).`,
            },
        }
    }
}
