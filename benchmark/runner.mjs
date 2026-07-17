import { performance } from 'node:perf_hooks'
import { buildInternalGraph } from '../src/graph/internal-builder.js'
import { detectEndpoints } from '../src/analysis/endpoints.js'
import { analyzeHttpContracts } from '../src/analysis/http-contracts.js'
import { BENCHMARK_BASELINE, BENCHMARK_BUDGETS, BENCHMARK_SCHEMA, CROSS_REPO_CASE, GOLDEN_CASES } from './cases.mjs'
import { benchmarkFrameworkConventions } from './framework-case.mjs'
import {edgeProvenance, summarizeEdgeProvenance} from '../src/graph/edge-provenance.js'

const endpointId = (value) => String(value && typeof value === 'object' ? value.id : value)
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const includes = (value, fragment) => endpointId(value).includes(fragment)

function checkGraph(graph, definition, endpoints) {
    const assertions = []
    for (const symbol of definition.symbols || []) {
        const pass = graph.nodes.some((node) => endpointId(node.id).includes(`#${symbol}@`))
        assertions.push({id: `symbol:${symbol}`, pass})
    }
    for (const expected of definition.edges || []) {
        const pass = graph.links.some((link) => link.relation === expected.relation
            && includes(link.source, expected.source) && includes(link.target, expected.target)
            && (expected.compileOnly == null || link.compileOnly === expected.compileOnly)
            && (expected.provenance == null || edgeProvenance(link) === expected.provenance))
        assertions.push({id: `edge:${expected.relation}:${expected.source}->${expected.target}`, pass})
    }
    for (const expected of definition.endpoints || []) {
        const pass = endpoints.some((item) => item.method === expected.method && item.path === expected.path && item.handler === expected.handler)
        assertions.push({id: `endpoint:${expected.method}:${expected.path}:${expected.handler}`, pass})
    }
    return assertions
}

async function benchmarkCase(definition) {
    const started = performance.now()
    const graph = await buildInternalGraph(definition.root)
    const coldMs = performance.now() - started
    const files = [...new Set(graph.nodes.map((node) => node.source_file).filter(Boolean))].sort()
    const endpoints = detectEndpoints(definition.root, files)
    const assertions = checkGraph(graph, definition, endpoints)
    const graphBytes = bytes(graph)
    const provenance = summarizeEdgeProvenance(graph.links)
    const gates = {
        correctness: assertions.every((assertion) => assertion.pass),
        provenance: graph.edgeProvenanceV === provenance.version && provenance.complete,
        graphBytes: graphBytes <= BENCHMARK_BUDGETS.maxCaseGraphBytes,
        coldLatency: coldMs <= BENCHMARK_BUDGETS.maxCaseColdMs,
    }
    return {
        id: definition.id,
        language: definition.language,
        files: files.length,
        nodes: graph.nodes.length,
        links: graph.links.length,
        endpoints: endpoints.length,
        graphBytes,
        provenance,
        coldMs: Number(coldMs.toFixed(2)),
        status: Object.values(gates).every(Boolean) ? 'PASS' : 'FAIL',
        gates,
        assertions,
        graph,
    }
}

async function benchmarkCrossRepo() {
    const started = performance.now()
    const [backendGraph, frontendGraph] = await Promise.all([
        buildInternalGraph(CROSS_REPO_CASE.backend),
        buildInternalGraph(CROSS_REPO_CASE.frontend),
    ])
    const analysis = analyzeHttpContracts({
        backend: {id: 'backend', repoRoot: CROSS_REPO_CASE.backend, graph: backendGraph},
        client: {id: 'frontend', repoRoot: CROSS_REPO_CASE.frontend, graph: frontendGraph},
    })
    const endpoint = analysis.endpoints.find((item) => item.method === 'GET' && item.normalizedPath === '/api/users/:param')
    const assertions = [
        {id: 'endpoint matched', pass: Boolean(endpoint)},
        {id: 'typed wrapper discovered', pass: analysis.wrapperDiscovery[0]?.discovered === 1},
        {id: 'external use proven', pass: endpoint?.liveness?.status === 'NOT_DEAD_EXTERNAL_USE'},
        {id: 'handler node resolved', pass: endpoint?.liveness?.canSuppressDeadCandidate === true},
        {id: 'affected screen found', pass: endpoint?.affected?.screens?.some((item) => item.file === 'src/pages/UsersPage.tsx') === true},
    ]
    const coldMs = performance.now() - started
    return {
        id: 'crossrepo-http', repositories: 2, coldMs: Number(coldMs.toFixed(2)),
        status: assertions.every((assertion) => assertion.pass) ? 'PASS' : 'FAIL',
        assertions,
        totals: analysis.totals,
    }
}

function publicCase(result) {
    const {graph: _graph, ...publicResult} = result
    return publicResult
}

function reportSize(report) {
    let previous = -1
    for (let index = 0; index < 4; index += 1) {
        report.metrics.reportBytes = bytes(report)
        if (report.metrics.reportBytes === previous) break
        previous = report.metrics.reportBytes
    }
    return report.metrics.reportBytes
}

export async function runGoldenBenchmark({includeLifecycle = true} = {}) {
    const cases = []
    for (const definition of GOLDEN_CASES) cases.push(await benchmarkCase(definition))
    const crossRepo = await benchmarkCrossRepo()
    const frameworkConventions = await benchmarkFrameworkConventions()
    const lifecycle = includeLifecycle
        ? await (await import('./lifecycle.mjs')).benchmarkLifecycle(GOLDEN_CASES[0].root)
        : null
    const totalColdMs = cases.reduce((sum, item) => sum + item.coldMs, 0) + crossRepo.coldMs
    const lifecycleGates = lifecycle ? {
        coldFull: lifecycle.coldUpdate === 'full',
        editIncremental: lifecycle.incrementalUpdate === 'incremental',
        unchangedNone: lifecycle.unchangedUpdate === 'none',
        reconnectNone: lifecycle.reconnectUpdate === 'none',
        activeTargetStable: lifecycle.activeTargetStable === true,
        revisionStable: lifecycle.revisionStable === true,
        reconnectLatency: lifecycle.reconnectMs <= BENCHMARK_BUDGETS.maxReconnectMs,
        textBytes: lifecycle.textResponseBytes <= BENCHMARK_BUDGETS.maxTextResponseBytes,
    } : {}
    const report = {
        schemaVersion: BENCHMARK_SCHEMA,
        comparisonBaseline: BENCHMARK_BASELINE,
        environment: {node: process.version, platform: process.platform, arch: process.arch},
        budgets: BENCHMARK_BUDGETS,
        cases: cases.map(publicCase),
        crossRepo,
        frameworkConventions,
        lifecycle,
        metrics: {totalColdMs: Number(totalColdMs.toFixed(2)), reportBytes: 0},
        gates: {
            cases: cases.every((item) => item.status === 'PASS'),
            crossRepo: crossRepo.status === 'PASS',
            frameworkConventions: frameworkConventions.status === 'PASS',
            totalColdLatency: totalColdMs <= BENCHMARK_BUDGETS.maxTotalColdMs,
            ...lifecycleGates,
            reportBytes: false,
        },
        gaps: {
            java: cases.find((item) => item.id === 'java')?.assertions.filter((item) => !item.pass).map((item) => item.id) || [],
            rust: cases.find((item) => item.id === 'rust')?.assertions.filter((item) => !item.pass).map((item) => item.id) || [],
        },
        status: 'FAIL',
    }
    reportSize(report)
    report.gates.reportBytes = report.metrics.reportBytes <= BENCHMARK_BUDGETS.maxReportBytes
    report.status = Object.values(report.gates).every(Boolean) ? 'PASS' : 'FAIL'
    reportSize(report)
    return report
}
