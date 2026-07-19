// Cross-repository HTTP contract intelligence. Repository paths are resolved only through the
// local global registry; callers can select an opaque repository UUID or an unambiguous label but
// can never pass an arbitrary filesystem path through this tool.
import {join} from 'node:path'
import {analyzeHttpContracts} from '../analysis/http-contracts.js'
import {analyzeTransportContracts} from '../analysis/transport-contracts.js'
import {buildGraphForRepo} from '../build-graph.js'
import {graphHomeDir} from '../graph/layout.js'
import {liveRepositoryRecords} from '../graph/repo-registry.js'
import {loadGraph} from './graph-context.mjs'
import {toolResult} from './tool-result.mjs'
import {contractVerdict, contractVerdictLine} from './company-contract-verdict.mjs'

const CROSS_REPO_HTTP_CONTRACT_V = 3
const selectorText = (value) => String(value ?? '').trim()

function selectRecord(records, selector) {
    const query = selectorText(selector)
    if (!query) return {error: 'repository selector is required'}
    const byId = records.find((record) => record.repositoryId === query)
    if (byId) return {record: byId}
    const byLabel = records.filter((record) => String(record.label || '').toLowerCase() === query.toLowerCase())
    if (byLabel.length === 1) return {record: byLabel[0]}
    if (byLabel.length > 1) return {
        error: `repository label "${query}" is ambiguous; use one of these repository IDs`,
        candidates: byLabel.map((record) => ({repositoryId: record.repositoryId, label: record.label})),
    }
    return {error: `repository "${query}" is not present in the live global graph registry`}
}

function safeAlias(record, records) {
    const base = String(record.label || 'repo').normalize('NFKC')
        .replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'repo'
    const duplicates = records.filter((item) => String(item.label || '').toLowerCase() === String(record.label || '').toLowerCase())
    return duplicates.length > 1 ? `${base}-${String(record.repositoryId).slice(0, 8)}` : base
}

function publicRecord(record, alias) {
    return {repositoryId: record.repositoryId, label: record.label, alias}
}

function safeRefreshReason(record, error) {
    let message = String(error instanceof Error ? error.message : error || 'graph refresh failed')
    for (const path of [record.repoPath, record.graphDir]) {
        if (!path) continue
        message = message.split(String(path)).join(record.label || 'repository')
        message = message.split(String(path).replace(/\\/g, '/')).join(record.label || 'repository')
    }
    return message.replace(/[\r\n]+/g, ' ').trim().slice(0, 400) || 'graph refresh failed'
}

async function reconcileGraph(record, alias, role, graphHome) {
    let registeredGraph = null
    try { registeredGraph = loadGraph(join(record.graphDir, 'graph.json'), {repoRoot: record.repoPath}) } catch { /* refresh may repair it */ }
    const buildMode = ['full', 'no-tests', 'tests-only'].includes(registeredGraph?.graphBuildMode)
        ? registeredGraph.graphBuildMode
        : 'full'
    const precision = registeredGraph?.graphPrecisionMode === 'off' ? 'off' : 'lsp'
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

export async function tTraceApiContract(_g, args = {}, ctx = {}) {
    const graphHome = ctx.graphHome || graphHomeDir()
    const records = liveRepositoryRecords(graphHome)
    if (!records.length) return toolResult(
        'VERDICT NOT_CONFIGURED — the global repository registry has no live graphs. Open/build both the backend and client repositories first.',
        {status: 'NOT_CONFIGURED', availableRepositories: []},
    )

    const backendSelection = selectRecord(records, args.backend)
    if (!backendSelection.record) return toolResult(
        `VERDICT INVALID_REPOSITORY — ${backendSelection.error}.`,
        {status: 'INVALID_REPOSITORY', role: 'backend', ...backendSelection, availableRepositories: records.map((record) => publicRecord(record, safeAlias(record, records)))},
    )
    const rawClients = Array.isArray(args.clients) ? args.clients.slice(0, 20) : []
    if (!rawClients.length) return toolResult(
        'VERDICT INVALID_REPOSITORY — at least one client repository ID or label is required.',
        {status: 'INVALID_REPOSITORY', role: 'clients'},
    )
    const clientRecords = []
    for (const selector of rawClients) {
        const selected = selectRecord(records, selector)
        if (!selected.record) return toolResult(
            `VERDICT INVALID_REPOSITORY — ${selected.error}.`,
            {status: 'INVALID_REPOSITORY', role: 'client', selector, ...selected},
        )
        if (!clientRecords.some((record) => record.repositoryId === selected.record.repositoryId)) clientRecords.push(selected.record)
    }
    if (clientRecords.some((record) => record.repositoryId === backendSelection.record.repositoryId)) return toolResult(
        'VERDICT INVALID_REPOSITORY — backend and client selections must be distinct repositories.',
        {status: 'INVALID_REPOSITORY', role: 'clients'},
    )

    const backend = backendSelection.record
    const backendAlias = safeAlias(backend, records)
    const clients = clientRecords.map((record) => ({record, alias: safeAlias(record, records)}))
    const reconciled = []
    for (const selected of [
        {record: backend, alias: backendAlias, role: 'backend'},
        ...clients.map(({record, alias}) => ({record, alias, role: 'client'})),
    ]) {
        reconciled.push(await reconcileGraph(selected.record, selected.alias, selected.role, graphHome))
    }
    const backendGraph = reconciled[0]
    const clientGraphs = reconciled.slice(1)
    const reconciliationReasons = reconciled.filter((item) => item.reason).map((item) => item.reason)
    const graphReconciliation = reconciled.map((item) => item.publicStatus)
    if (!backendGraph.graph || clientGraphs.some((item) => !item.graph)) {
        const reasons = reconciliationReasons.length ? reconciliationReasons : ['one or more selected graphs could not be refreshed and loaded']
        const completeness = {complete: false, status: 'PARTIAL', reasons}
        return toolResult(
            `VERDICT PARTIAL — selected repository graphs could not all be refreshed and loaded.\nCompleteness: partial — ${reasons.join('; ')}.`,
            {
                crossRepoHttpContractV: CROSS_REPO_HTTP_CONTRACT_V,
                status: 'PARTIAL',
                repositories: {
                    backend: publicRecord(backend, backendAlias),
                    clients: clients.map(({record, alias}) => publicRecord(record, alias)),
                },
                graphReconciliation,
                completeness,
            },
            {completeness, warnings: [{code: 'CROSS_REPO_GRAPH_REFRESH_PARTIAL', message: reasons.join('; ')}]},
        )
    }

    try {
        let analysis = analyzeHttpContracts({
            backend: {id: backendAlias, repoRoot: backend.repoPath, graph: backendGraph.graph},
            clients: clientGraphs.map((item) => ({id: item.alias, repoRoot: item.record.repoPath, graph: item.graph})),
            method: args.method,
            path: args.path,
            changedFiles: args.changed_files,
            includeTests: args.include_tests === true,
            clientNames: args.client_names,
            wrappers: args.client_wrappers,
            autoDiscoverWrappers: args.auto_discover_wrappers !== false,
            maxImpactDepth: args.max_impact_depth,
            maxEndpoints: args.max_endpoints,
            maxMatches: args.max_matches,
            maxAffectedFiles: args.max_affected_files,
            runtimeValues: args.runtime_config,
        })
        const selectedTransport = ['all', 'http', 'graphql', 'grpc', 'event'].includes(args.transport) ? args.transport : 'all'
        if (!['all', 'http'].includes(selectedTransport)) analysis = {
            ...analysis, status: 'complete', completeness: {complete: true, reasons: []}, endpoints: [], uncertain: [],
            totals: {...analysis.totals, endpoints: 0, clientCalls: 0, matches: 0, methodMismatches: 0, uncertainCalls: 0, notDeadExternalUse: 0, notDeadExternalHandlers: 0, possibleExternalUse: 0, unknownLiveness: 0},
        }
        const transportAnalysis = selectedTransport === 'http'
            ? {transportContractsV: 2, transport: 'http', status: 'COMPLETE', completeness: {complete: true, reasons: []}, totals: {contracts: 0, matches: 0, uncertain: 0, filesScanned: 0, runtimeObservations: 0, runtimeResolved: 0, runtimeReportsComplete: 0}, contracts: [], uncertain: [], runtimeEvidence: {status: 'NOT_APPLICABLE', reports: [], resolvedUnknowns: 0}}
            : analyzeTransportContracts({
                backend: {id: backendAlias, repoRoot: backend.repoPath, graph: backendGraph.graph},
                clients: clientGraphs.map((item) => ({id: item.alias, repoRoot: item.record.repoPath, graph: item.graph})),
                transport: selectedTransport === 'all' ? 'all' : selectedTransport,
                includeTests: args.include_tests === true,
                maxImpactDepth: args.max_impact_depth,
                maxAffectedFiles: args.max_affected_files,
                runtimeEvidenceFiles: args.runtime_evidence_files,
                runtimeEvidenceMaxAgeHours: args.runtime_evidence_max_age_hours,
            })
        const verdict = contractVerdict(analysis, transportAnalysis)
        const reasons = [...new Set([...reconciliationReasons, ...(analysis.completeness?.reasons || []), ...(transportAnalysis.completeness?.reasons || [])])]
        const completeness = {
            complete: reasons.length === 0 && analysis.completeness?.complete === true,
            status: reasons.length === 0 && analysis.completeness?.complete === true ? 'COMPLETE' : 'PARTIAL',
            reasons,
        }
        const topN = Math.max(1, Math.min(50, Number(args.top_n) || 10))
        const ranked = [...analysis.endpoints].sort((left, right) =>
            right.callsites.length - left.callsites.length ||
            right.affected.files.length - left.affected.files.length ||
            left.path.localeCompare(right.path))
        const lines = [
            contractVerdictLine(verdict, analysis.totals.endpoints + transportAnalysis.totals.contracts),
            `Scope: ${backend.label} → ${clients.map(({record}) => record.label).join(', ')}; ${analysis.totals.endpoints} HTTP endpoint(s), ${transportAnalysis.totals.contracts} GraphQL/gRPC/event contract(s), ${analysis.totals.clientCalls} inspected HTTP call(s), ${verdict.uncertainCalls} uncertain.`,
            ...ranked.slice(0, topN).flatMap((endpoint) => {
                const location = endpoint.file ? ` (${endpoint.backend}:${endpoint.file}${endpoint.line ? `:${endpoint.line}` : ''})` : ''
                const callsites = endpoint.callsites.slice(0, 3)
                    .map((call) => `    caller ${call.clientRepo}:${call.file}:${call.line} (${call.match.confidence}, ${call.match.kind})`)
                const screens = endpoint.affected.screens.slice(0, 3)
                    .map((screen) => `    screen ${screen.client}:${screen.file} (distance ${screen.distance})`)
                return [
                    `  ${endpoint.method} ${endpoint.path}${location} [${endpoint.liveness.status}${endpoint.handler ? `; handler ${endpoint.handler}` : ''}] → ${endpoint.callsites.length} callsite(s), ${endpoint.affected.screens.length} screen(s), ${endpoint.affected.files.length} affected file(s)`,
                    ...callsites,
                    ...screens,
                ]
            }),
            ...transportAnalysis.contracts.filter((contract) => contract.callsites.length).slice(0, topN).map((contract) =>
                `  ${contract.transport.toUpperCase()} ${contract.service ? `${contract.service}.` : contract.operation ? `${contract.operation} ` : ''}${contract.name} (${contract.file}:${contract.line}) [${contract.liveness}] → ${contract.callsites.length} callsite(s), ${contract.affected.files.length} affected file(s)`),
            completeness.complete
                ? 'Completeness: complete within the declared repository graphs, supported static models and fresh revision-bound runtime capture.'
                : `Completeness: partial — ${completeness.reasons.join('; ')}.`,
        ]
        const result = {
            crossRepoHttpContractV: CROSS_REPO_HTTP_CONTRACT_V,
            verdict,
            repositories: {
                backend: publicRecord(backend, backendAlias),
                clients: clients.map(({record, alias}) => publicRecord(record, alias)),
            },
            ...analysis,
            transportContracts: transportAnalysis,
            status: completeness.status,
            graphReconciliation,
            completeness,
        }
        return toolResult(lines.join('\n'), result, {
            completeness,
            warnings: completeness.complete ? [] : [{code: 'CROSS_REPO_ANALYSIS_PARTIAL', message: completeness.reasons.join('; ')}],
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'cross-repository analysis failed'
        const completeness = {complete: false, status: 'PARTIAL', reasons: [reason]}
        return toolResult(
            `VERDICT PARTIAL — ${reason}.`,
            {status: 'PARTIAL', graphReconciliation, completeness},
            {completeness, warnings: [{code: 'CROSS_REPO_ANALYSIS_PARTIAL', message: reason}]},
        )
    }
}
