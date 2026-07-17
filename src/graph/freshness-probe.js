// Fast repository freshness probe. Full graph snapshots hash every source file and are still the
// authority when something changed; this exact Git/worktree token is safe to cache in-process and in
// versioned graph metadata when HEAD + dirty/untracked/control-file content remain unchanged.
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {readFileSync, statSync} from 'node:fs'
import {createRequire} from 'node:module'
import {childProcessEnv} from '../child-env.js'
import {createRepoBoundary} from '../repo-path.js'

export const REPOSITORY_FRESHNESS_PROBE_V = 1
export const GRAPH_BUILDER_SCHEMA_V = 5
export const GRAPH_BUILDER_VERSION = (() => {
    try { return String(createRequire(import.meta.url)('../../package.json').version) }
    catch { return '0.0.0' }
})()

// These are the graph capabilities whose meaning is owned by the current builder. The package
// version invalidates stamps across releases; the explicit schema requirements also fail closed when
// a saved graph is hand-edited or a development build bumps a structural schema without a version bump.
const CURRENT_GRAPH_SCHEMA = Object.freeze({
    extImportsV: 2,
    edgeTypesV: 2,
    edgeProvenanceV: 1,
    complexityV: 2,
    repoBoundaryV: 1,
    barrelResolutionV: 1,
    reExportOccurrencesV: 1,
    symbolSpacesV: 1,
    extractorSchemaV: 5,
})
const CONTROL_FILES = ['.gitignore', '.weavatrixignore', '.weavatrix.json']
const MAX_CONTROL_BYTES = 1_000_000

function git(repoRoot, args) {
    const result = spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'buffer', timeout: 8000, windowsHide: true, env: childProcessEnv(), maxBuffer: 16 * 1024 * 1024,
    })
    return result.status === 0 ? Buffer.from(result.stdout || '') : null
}

function statusPaths(status) {
    const records = status.toString('utf8').split('\0').filter(Boolean)
    const paths = []
    for (let index = 0; index < records.length; index++) {
        const record = records[index]
        if (record.length < 4) continue
        paths.push(record.slice(3))
        // In porcelain -z, rename/copy destinations are followed by the original path as a bare item.
        if (/^[RC]/.test(record) || /^[RC]/.test(record.slice(1, 2))) {
            if (records[index + 1]) paths.push(records[++index])
        }
    }
    return [...new Set(paths)]
}

export function repositoryFreshnessProbe(repoRoot) {
    const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD'])
    const status = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'])
    if (!head || !status) return null
    const digest = createHash('sha256').update(head).update(status)
    const boundary = createRepoBoundary(repoRoot)
    for (const rel of statusPaths(status).sort()) {
        digest.update(rel)
        const resolved = boundary.resolve(rel)
        if (!resolved.ok) { digest.update(`!${resolved.reason}`); continue }
        try {
            const stats = statSync(resolved.path)
            if (!stats.isFile()) { digest.update('!not-file'); continue }
            // Dirty sets are normally tiny. Hashing their content makes same-size rapid edits exact while
            // still avoiding reads of every clean file in the repository.
            digest.update(readFileSync(resolved.path))
        } catch { digest.update('!unreadable') }
    }
    // Control files can intentionally be gitignored. Always include their bounded contents so a
    // matching Git status can never hide a changed graph universe/classification policy.
    for (const rel of CONTROL_FILES) {
        digest.update(`control:${rel}\0`)
        const resolved = boundary.resolve(rel)
        if (!resolved.ok) { digest.update(`!${resolved.reason}`); continue }
        try {
            const stats = statSync(resolved.path)
            if (!stats.isFile()) { digest.update('!not-file'); continue }
            if (stats.size > MAX_CONTROL_BYTES) { digest.update('!oversized'); continue }
            digest.update(readFileSync(resolved.path))
        } catch { digest.update('!unreadable') }
    }
    return digest.digest('hex')
}

const isHash = (value) => /^[a-f0-9]{64}$/.test(String(value || ''))

export function graphSchemaIsCurrent(graph) {
    return Boolean(graph) && Object.entries(CURRENT_GRAPH_SCHEMA)
        .every(([key, expected]) => Number(graph[key]) === expected)
}

// Returns true only when a graph stamp was produced by this exact builder contract for the active
// complete build mode. Legacy, scoped, non-Git, malformed and schema-old graphs all fall through to
// the authoritative repository snapshot path.
export function persistedFreshnessMatches(graph, probe, mode = graph?.graphBuildMode || 'full') {
    if (!graph || !isHash(probe) || !graphSchemaIsCurrent(graph)) return false
    if (Number(graph.repositoryFreshnessProbeV) !== REPOSITORY_FRESHNESS_PROBE_V) return false
    if (Number(graph.repositoryFreshnessBuilderSchemaV) !== GRAPH_BUILDER_SCHEMA_V) return false
    if (String(graph.repositoryFreshnessBuilderVersion || '') !== GRAPH_BUILDER_VERSION) return false
    if (String(graph.repositoryFreshnessProbe || '') !== probe) return false
    if (String(graph.repositoryFreshnessMode || '') !== String(mode || 'full')) return false
    if (String(graph.graphBuildMode || '') !== String(mode || 'full')) return false
    if (String(graph.graphBuildScope || '') !== '') return false
    return true
}

// Mutates the graph metadata and reports whether serialization is required. A null probe deliberately
// removes an older stamp: non-Git repos and repositories that changed while parsing must never inherit
// a stale fast-path token.
export function stampRepositoryFreshness(graph, probe, mode = graph?.graphBuildMode || 'full') {
    if (!graph || typeof graph !== 'object') return false
    const next = isHash(probe) && graphSchemaIsCurrent(graph) && !graph.graphBuildScope
        ? {
            repositoryFreshnessProbeV: REPOSITORY_FRESHNESS_PROBE_V,
            repositoryFreshnessBuilderSchemaV: GRAPH_BUILDER_SCHEMA_V,
            repositoryFreshnessBuilderVersion: GRAPH_BUILDER_VERSION,
            repositoryFreshnessProbe: probe,
            repositoryFreshnessMode: String(mode || 'full'),
        }
        : null
    const keys = [
        'repositoryFreshnessProbeV',
        'repositoryFreshnessBuilderSchemaV',
        'repositoryFreshnessBuilderVersion',
        'repositoryFreshnessProbe',
        'repositoryFreshnessMode',
    ]
    let changed = false
    for (const key of keys) {
        if (next && Object.hasOwn(next, key)) {
            if (graph[key] !== next[key]) { graph[key] = next[key]; changed = true }
        } else if (Object.hasOwn(graph, key)) {
            delete graph[key]
            changed = true
        }
    }
    return changed
}
