import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { buildInternalGraph } from '../src/graph/internal-builder.js'
import { detectEndpoints } from '../src/analysis/endpoints.js'
import { createPathClassifier, hasPathClass } from '../src/path-classification.js'
import {summarizeEdgeProvenance} from '../src/graph/edge-provenance.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const REAL_MANIFEST = fileURLToPath(new URL('./real-repositories.json', import.meta.url))
export const REAL_BASELINE = fileURLToPath(new URL('./real-baseline-0.2.1.json', import.meta.url))
const NON_PRODUCT = ['test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp']
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const sortedObject = (entries) => Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)))

export function loadRealRepositoryManifest(path = REAL_MANIFEST) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    if (manifest?.schemaVersion !== 'weavatrix.real-repositories.v1' || !Array.isArray(manifest.repositories)) {
        throw new Error('Unsupported real-repository benchmark manifest')
    }
    return manifest
}

function repositoryRoot(definition) {
    const candidates = [process.env[definition.environment], ...(definition.candidates || []).map((path) => resolve(PROJECT_ROOT, path))]
    for (const candidate of candidates.filter(Boolean)) {
        try {
            const root = realpathSync(candidate)
            if (statSync(root).isDirectory()) return root
        } catch { /* keep looking */ }
    }
    return null
}

function gitState(root) {
    try {
        const options = {encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}
        const prefix = ['-c', `safe.directory=${root}`, '-C', root]
        const revision = execFileSync('git', [...prefix, 'rev-parse', 'HEAD'], options).trim()
        const dirty = Boolean(execFileSync('git', [...prefix, 'status', '--porcelain', '--untracked-files=no'], options).trim())
        return {revision, dirty}
    } catch { return {revision: null, dirty: null} }
}

async function withSafeGitDirectory(root, action) {
    const count = Number.parseInt(process.env.GIT_CONFIG_COUNT || '0', 10) || 0
    const keys = ['GIT_CONFIG_COUNT', `GIT_CONFIG_KEY_${count}`, `GIT_CONFIG_VALUE_${count}`]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.GIT_CONFIG_COUNT = String(count + 1)
    process.env[`GIT_CONFIG_KEY_${count}`] = 'safe.directory'
    process.env[`GIT_CONFIG_VALUE_${count}`] = root
    try { return await action() } finally {
        for (const key of keys) {
            if (previous[key] == null) delete process.env[key]
            else process.env[key] = previous[key]
        }
    }
}

function count(values) {
    const result = new Map()
    for (const value of values) result.set(value, (result.get(value) || 0) + 1)
    return sortedObject(result)
}

function graphMetrics(root, graph, definition, coldMs) {
    const files = [...new Set(graph.nodes.map((node) => node.source_file).filter(Boolean))].sort()
    const classifier = createPathClassifier(root)
    const classified = files.map((file) => classifier.explain(file))
    const endpoints = detectEndpoints(root, files)
    const provenance = summarizeEdgeProvenance(graph.links)
    const metrics = {
        files: files.length,
        languageFiles: files.filter((file) => definition.extensions.includes(extname(file).toLowerCase())).length,
        symbols: graph.nodes.filter((node) => String(node.id).includes('#')).length,
        nodes: graph.nodes.length,
        links: graph.links.length,
        relations: count(graph.links.map((link) => String(link.relation || 'unknown'))),
        symbolKinds: count(graph.nodes.filter((node) => String(node.id).includes('#')).map((node) => String(node.symbol_kind || 'unknown'))),
        endpoints: endpoints.length,
        endpointMethods: count(endpoints.map((endpoint) => endpoint.method)),
        edgeProvenanceV: Number(graph.edgeProvenanceV) || 0,
        edgeProvenance: provenance.counts,
        edgeProvenanceComplete: provenance.complete,
        testFiles: classified.filter((info) => hasPathClass(info, 'test', 'e2e')).length,
        generatedFiles: classified.filter((info) => hasPathClass(info, 'generated')).length,
        nonProductFiles: classified.filter((info) => info.excluded || hasPathClass(info, ...NON_PRODUCT)).length,
        graphBytes: bytes(graph),
        coldMs: Number(coldMs.toFixed(2)),
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({...metrics, coldMs: 0, graphBytes: 0})).digest('hex').slice(0, 16)
    return {metrics, fingerprint}
}

function expectationGaps(metrics, expectations = {}) {
    const gaps = []
    const checkMinimums = (field, minimums, code) => {
        for (const [name, minimum] of Object.entries(minimums || {})) {
            const actual = Number(metrics[field]?.[name]) || 0
            if (actual < minimum) gaps.push({code, signal: name, expectedMinimum: minimum, actual})
        }
    }
    checkMinimums('symbolKinds', expectations.minSymbolKinds, 'SYMBOL_KIND_COVERAGE_GAP')
    checkMinimums('relations', expectations.minRelations, 'RELATION_COVERAGE_GAP')
    if (Number.isFinite(expectations.minEndpoints) && metrics.endpoints < expectations.minEndpoints) {
        gaps.push({code: 'ENDPOINT_COVERAGE_GAP', expectedMinimum: expectations.minEndpoints, actual: metrics.endpoints})
    }
    return gaps
}

function compareRelations(current, baseline, allowed = {}) {
    if (!baseline) return {status: 'UNBASELINED', regressions: []}
    const regressions = []
    for (const [relation, before] of Object.entries(baseline.metrics?.relations || {})) {
        const after = current.metrics.relations[relation] || 0
        const drop = before > 0 ? (before - after) / before : 0
        if (drop <= 0.05) continue
        regressions.push({relation, before, after, dropPercent: Number((drop * 100).toFixed(2)), explanation: allowed[relation] || null})
    }
    return {status: regressions.some((item) => !item.explanation) ? 'REGRESSION' : 'PASS', regressions}
}

async function inspectRepository(definition, baseline, builder) {
    const root = repositoryRoot(definition)
    if (!root) return {
        id: definition.id, language: definition.language, status: 'MISSING',
        reason: `Set ${definition.environment} to a source checkout`,
        gaps: [{code: 'SOURCE_CHECKOUT_MISSING', environment: definition.environment}],
    }
    try {
        const started = performance.now()
        const graph = await withSafeGitDirectory(root, () => builder(root))
        const measured = graphMetrics(root, graph, definition, performance.now() - started)
        const state = gitState(root)
        const comparison = compareRelations(measured, baseline, definition.allowedRelationRegressions)
        const comparableRevision = !baseline?.revision || !state.revision || baseline.revision === state.revision
        const gaps = expectationGaps(measured.metrics, definition.expectations)
        const gates = {
            languagePresent: measured.metrics.languageFiles > 0,
            provenance: measured.metrics.edgeProvenanceV >= 1 && measured.metrics.edgeProvenanceComplete,
            expectedSignals: gaps.length === 0,
            relationRegression: comparison.status !== 'REGRESSION',
            baselineRevision: comparableRevision,
        }
        const structuralPass = gates.languagePresent && gates.provenance && gates.expectedSignals && gates.relationRegression
        const status = !structuralPass ? 'FAIL'
            : !gates.baselineRevision ? 'STALE'
            : comparison.status === 'UNBASELINED' ? 'UNBASELINED' : 'PASS'
        return {id: definition.id, language: definition.language, status, revision: state.revision, dirty: state.dirty, ...measured, gaps, comparison, gates}
    } catch (error) {
        return {id: definition.id, language: definition.language, status: 'FAIL', reason: String(error?.message || error).replaceAll(root, '<repo>')}
    }
}

export async function runRealRepositoryBenchmark({manifestPath = REAL_MANIFEST, baselinePath = REAL_BASELINE, builder = buildInternalGraph} = {}) {
    const manifest = loadRealRepositoryManifest(manifestPath)
    const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {repositories: {}}
    const repositories = []
    for (const definition of manifest.repositories) repositories.push(await inspectRepository(definition, baseline.repositories?.[definition.id], builder))
    const counts = count(repositories.map((repository) => repository.status))
    const report = {
        schemaVersion: 'weavatrix.real-benchmark.v1', baselineVersion: manifest.baselineVersion,
        repositories, counts, completeness: repositories.every((repository) => repository.status === 'PASS') ? 'COMPLETE' : 'PARTIAL',
        gaps: Object.fromEntries(repositories.filter((repository) => ['Java', 'Rust'].includes(repository.language))
            .map((repository) => [repository.language.toLowerCase(), repository.gaps || []])),
        reportBytes: 0, status: repositories.some((repository) => repository.status === 'FAIL') ? 'FAIL' : 'PARTIAL',
    }
    if (report.completeness === 'COMPLETE') report.status = 'PASS'
    report.reportBytes = bytes(report)
    if (report.reportBytes > 64 * 1024) report.status = 'FAIL'
    return report
}

export function baselineFromReport(report, version = '0.2.1') {
    return {
        schemaVersion: 'weavatrix.real-baseline.v1', builderVersion: version,
        repositories: Object.fromEntries(report.repositories.filter((item) => item.metrics).map((item) => [item.id, {
            revision: item.revision, fingerprint: item.fingerprint, metrics: item.metrics,
        }])),
    }
}
