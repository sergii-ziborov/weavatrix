import {join} from 'node:path'
import {buildGraphForRepo} from '../build-graph.js'
import {persistedFreshnessMatches, repositoryFreshnessProbe} from '../graph/freshness-probe.js'
import {loadGraph} from './graph-context.mjs'

export const publicRecord = (record, alias) => ({repositoryId: record.repositoryId, label: record.label, alias})

function safeRefreshReason(record, error) {
    let message = String(error instanceof Error ? error.message : error || 'graph refresh failed')
    for (const path of [record.repoPath, record.graphDir]) {
        if (!path) continue
        message = message.split(String(path)).join(record.label || 'repository')
        message = message.split(String(path).replace(/\\/g, '/')).join(record.label || 'repository')
    }
    return message.replace(/[\r\n]+/g, ' ').trim().slice(0, 400) || 'graph refresh failed'
}

export async function reconcileGraph(record, alias, role, graphHome) {
    let registeredGraph = null
    try { registeredGraph = loadGraph(join(record.graphDir, 'graph.json'), {repoRoot: record.repoPath}) } catch { /* refresh may repair it */ }
    const buildMode = ['full', 'no-tests', 'tests-only'].includes(registeredGraph?.graphBuildMode)
        ? registeredGraph.graphBuildMode
        : 'full'
    const precision = registeredGraph?.graphPrecisionMode === 'off' ? 'off' : 'lsp'
    const freshnessProbe = repositoryFreshnessProbe(record.repoPath)
    if (registeredGraph && freshnessProbe && persistedFreshnessMatches(registeredGraph, freshnessProbe, buildMode)) {
        return {
            record,
            alias,
            graph: registeredGraph,
            publicStatus: {
                role,
                repository: publicRecord(record, alias),
                buildMode,
                status: 'CURRENT',
                refresh: {kind: 'none', reason: 'persisted-freshness-match', changedFileCount: 0},
            },
        }
    }
    let build
    try {
        build = await buildGraphForRepo(record.repoPath, {
            mode: buildMode,
            precision,
            scope: '',
            outDir: record.graphDir,
            graphHome,
        })
    } catch (error) {
        build = {ok: false, error: safeRefreshReason(record, error)}
    }
    const refreshKind = build?.refresh?.kind || null
    const changedFiles = Array.isArray(build?.refresh?.changedFiles) ? build.refresh.changedFiles : []
    const publicStatus = {
        role,
        repository: publicRecord(record, alias),
        buildMode,
        status: build?.ok ? (refreshKind === 'none' ? 'CURRENT' : 'REFRESHED') : 'STALE_FALLBACK',
        refresh: build?.ok ? {
            kind: refreshKind || 'full',
            reason: String(build?.refresh?.reason || 'graph-rebuilt'),
            changedFileCount: changedFiles.length,
        } : null,
    }
    if (build?.ok) {
        try {
            return {record, alias, graph: loadGraph(join(record.graphDir, 'graph.json'), {repoRoot: record.repoPath}), publicStatus}
        } catch (error) {
            const reason = `refreshed graph could not be loaded: ${safeRefreshReason(record, error)}`
            return {record, alias, graph: null, reason, publicStatus: {...publicStatus, status: 'FAILED', reason}}
        }
    }

    const reason = `graph refresh failed: ${safeRefreshReason(record, build?.error)}`
    try {
        return {
            record,
            alias,
            graph: loadGraph(join(record.graphDir, 'graph.json'), {repoRoot: record.repoPath}),
            reason: `${reason}; stale registered graph used`,
            publicStatus: {...publicStatus, reason: `${reason}; stale registered graph used`},
        }
    } catch (error) {
        const loadReason = `${reason}; registered graph could not be loaded: ${safeRefreshReason(record, error)}`
        return {record, alias, graph: null, reason: loadReason, publicStatus: {...publicStatus, status: 'FAILED', reason: loadReason}}
    }
}
