// Shared graph core for the MCP tool modules: graph loading + indexes, node resolution, staleness,
// the raw-graph cache, and the structural diff helpers. This module holds process-lifetime CACHES
// (staleness, raw graph), so every tool module imports it STATICALLY — it is the one part of src/mcp
// that does NOT hot-reload (editing it needs an MCP reconnect, same as the analysis engines).
import {readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../child-env.js'
import {resolveRepoPath} from '../repo-path.js'
import {isStructuralRelation} from '../graph/relations.js'
import {edgeProvenance} from '../graph/edge-provenance.js'

// ---- graph load + indexes -----------------------------------------------------------------------
export function loadGraph(path) {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
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
    const out = new Map() // id -> [{id, relation, confidence}]
    const inn = new Map()
    const push = (map, k, v) => {
        if (!map.has(k)) map.set(k, [])
        map.get(k).push(v)
    }
    for (const e of links) {
        if (!e || e.source == null || e.target == null) continue
        const s = String(e.source)
        const t = String(e.target)
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
    }
}

export const isSymbol = (id) => String(id).includes('#')
export const labelOf = (g, id) => {
    const n = g.byId.get(String(id))
    return n ? String(n.label ?? n.id) : String(id)
}

// Connectivity ignores structural file/symbol and class/method ownership, so runtime/compile-time
// dependency ranks never treat nesting as a call or import.
export const connList = (list) => (list || []).filter((e) => !isStructuralRelation(e.relation) && e.barrelProxy !== true)
export const degreeOf = (g, id) => connList(g.out.get(id)).length + connList(g.inn.get(id)).length
export const uniqueConnCount = (list) => new Set(connList(list).map((e) => String(e.id))).size

// Resolve a user-supplied "label" to a node: exact id → exact label → ci label → substring (best degree).
// Returns {node, matches, alternates} so callers can disclose ambiguity instead of silently picking one.
export function resolveNodeInfo(g, query) {
    const q = String(query ?? '').trim()
    if (!q) return {node: null, matches: 0, alternates: []}
    if (g.byId.has(q)) return {node: g.byId.get(q), matches: 1, alternates: []}
    const lc = q.toLowerCase()
    const exactLabel = g.byLabel.get(lc)
    if (exactLabel?.length) return pickBest(g, exactLabel)
    // substring over id + label
    const hits = []
    for (const n of g.nodes) {
        const id = String(n.id).toLowerCase()
        const lbl = String(n.label ?? '').toLowerCase()
        if (id.includes(lc) || lbl.includes(lc)) hits.push(n)
        if (hits.length > 500) break
    }
    return hits.length ? pickBest(g, hits) : {node: null, matches: 0, alternates: []}
}
export const resolveNode = (g, query) => resolveNodeInfo(g, query).node
function pickBest(g, list) {
    const node = bestByDegree(g, list)
    const alternates = list
        .filter((n) => n !== node)
        .sort((a, b) => degreeOf(g, b.id) - degreeOf(g, a.id))
        .slice(0, 4)
        .map((n) => `${n.label ?? n.id} [${n.id}]`)
    return {node, matches: list.length, alternates}
}
// One-line disclosure when a fuzzy label matched several nodes — silently picking one hides wrong-node errors.
export function ambiguityNote(query, info) {
    if (!info.node || info.matches <= 1) return null
    const more = info.matches - 1 - info.alternates.length
    return `Note: "${query}" matched ${info.matches} nodes; using the best-connected. Others: ${info.alternates.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
}
const bestByDegree = (g, list) =>
    list.reduce((best, n) => (degreeOf(g, n.id) > degreeOf(g, best.id) ? n : best), list[0])

const QUERY_STOP = new Set('a an and are around architecture code do does explain find for from how in is me of or project repository show the through to trace what where which with'.split(' '))
const QUERY_INTENTS = [
    ['bootstrap', ['bootstrap', 'startup', 'entrypoint', 'entry', 'main', 'root', 'app', 'index']],
    ['auth', ['auth', 'authentication', 'authorization', 'login', 'session', 'authgate']],
    ['routing', ['routing', 'router', 'routes', 'route', 'navigation']],
    ['layout', ['layout', 'layouts', 'shell']],
    ['api', ['api', 'apis', 'endpoint', 'endpoints', 'client']],
    ['state', ['state', 'store', 'stores', 'reducer', 'context']],
]
const INTENT_BY_TERM = new Map(QUERY_INTENTS.flatMap(([id, terms]) => terms.map((term) => [term, {id, terms}])))
const wordsOf = (value) => String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
const normPath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

function queryConcepts(query) {
    const seen = new Set()
    const concepts = []
    for (const raw of wordsOf(query)) {
        if (raw.length < 2 || QUERY_STOP.has(raw)) continue
        const intent = INTENT_BY_TERM.get(raw)
        const id = intent?.id || raw
        if (seen.has(id)) continue
        seen.add(id)
        concepts.push({id, raw, terms: intent ? [raw, ...intent.terms.filter((term) => term !== raw)] : [raw]})
    }
    return concepts
}

function conceptScore(g, node, concept) {
    const id = normPath(node.id)
    const label = String(node.label ?? '').toLowerCase()
    const source = normPath(node.source_file)
    const stem = (label.split('/').pop() || '').replace(/\.[^.]+$/, '')
    const words = new Set(wordsOf(`${node.id} ${node.label ?? ''} ${node.source_file ?? ''}`))
    const segments = new Set(source.split('/').flatMap((part) => wordsOf(part.replace(/\.[^.]+$/, ''))))
    let match = 0
    concept.terms.forEach((term, index) => {
        const primary = index === 0
        if (label === term || stem === term) match = Math.max(match, primary ? 60 : 42)
        else if (segments.has(term)) match = Math.max(match, primary ? 48 : 36)
        else if (words.has(term)) match = Math.max(match, primary ? 36 : 25)
        else if (term.length >= 4 && (id.includes(term) || label.includes(term))) match = Math.max(match, primary ? 12 : 7)
    })
    if (!match) return 0
    const fileNode = !isSymbol(node.id)
    const depth = source ? source.split('/').length : 9
    const entryBoost = concept.id === 'bootstrap' && /^(bootstrap|main|app|index|root)$/.test(stem) ? 10 : 0
    return match + (fileNode ? 7 : 0) + Math.max(0, 4 - depth) + entryBoost + Math.min(2, degreeOf(g, node.id) / 40)
}

// Natural-language graph search keeps one strong candidate per concept before filling by aggregate
// score. This prevents a broad architecture question from spending every seed on one dense API area.
export function findSeeds(g, query, limit = 8) {
    const concepts = queryConcepts(query)
    if (!concepts.length || limit <= 0) return []
    const rows = g.nodes.map((node) => {
        const scores = concepts.map((concept) => conceptScore(g, node, concept))
        return {node, scores, total: Math.max(...scores) + scores.reduce((sum, score) => sum + score, 0) / 10}
    })
    const chosen = []
    const used = new Set()
    for (let index = 0; index < concepts.length && chosen.length < limit; index++) {
        const best = rows.filter((row) => !used.has(String(row.node.id)) && row.scores[index] > 0)
            .sort((a, b) => b.scores[index] - a.scores[index] || String(a.node.id).localeCompare(String(b.node.id)))[0]
        if (best) { chosen.push(best.node); used.add(String(best.node.id)) }
    }
    rows.filter((row) => row.total > 0 && !used.has(String(row.node.id)))
        .sort((a, b) => b.total - a.total || String(a.node.id).localeCompare(String(b.node.id)))
        .slice(0, Math.max(0, limit - chosen.length))
        .forEach((row) => chosen.push(row.node))
    return chosen
}

export function resolveSeedFiles(g, requested, limit = 12) {
    const files = Array.isArray(requested) ? requested.slice(0, limit) : []
    const seeds = []
    const missing = []
    for (const raw of files) {
        const wanted = normPath(raw)
        const node = g.nodes.find((candidate) => !isSymbol(candidate.id)
            && (normPath(candidate.id) === wanted || normPath(candidate.source_file) === wanted))
        if (!node) missing.push(String(raw))
        else if (!seeds.some((seed) => String(seed.id) === String(node.id))) seeds.push(node)
    }
    return {seeds, missing}
}

// undirected adjacency for reachability (query/shortest path)
export function undirectedNeighbors(g, id) {
    const seen = new Map()
    for (const e of g.out.get(id) || []) if (e.barrelProxy !== true) seen.set(e.id, e.relation)
    for (const e of g.inn.get(id) || []) if (e.barrelProxy !== true && !seen.has(e.id)) seen.set(e.id, e.relation)
    return seen
}

// ---- staleness ----------------------------------------------------------------------------------
// The graph is a point-in-time build of graph.json; without a freshness signal an agent cannot tell
// whether answers reflect the current code. Compare graph.json mtime with the repo's latest commit
// (cheap `git log -1`), cached for 60s so per-tool warnings don't spawn git on every call.
let stalenessCache = {key: '', checkedAt: 0, info: null}
export function graphStaleness(ctx) {
    const now = Date.now()
    if (stalenessCache.info && stalenessCache.key === ctx.graphPath && now - stalenessCache.checkedAt < 60_000) return stalenessCache.info
    const info = {builtAt: null, headAt: null, stale: false, behind: null}
    try { info.builtAt = statSync(ctx.graphPath).mtime } catch { /* no graph file — nothing to report */ }
    if (ctx.repoRoot && info.builtAt) {
        try {
            const head = spawnSync('git', ['-C', ctx.repoRoot, 'log', '-1', '--format=%cI'], {encoding: 'utf8', timeout: 4000, env: childProcessEnv()})
            const iso = (head.stdout || '').trim()
            if (head.status === 0 && iso) {
                info.headAt = new Date(iso)
                if (info.headAt > info.builtAt) {
                    info.stale = true
                    const cnt = spawnSync('git', ['-C', ctx.repoRoot, 'rev-list', '--count', `--since=${info.builtAt.toISOString()}`, 'HEAD'], {encoding: 'utf8', timeout: 4000, env: childProcessEnv()})
                    if (cnt.status === 0) info.behind = Number(cnt.stdout.trim()) || null
                }
            }
        } catch { /* git unavailable — degrade to builtAt only */ }
        // Uncommitted work drifts line numbers just as hard as commits do (that is how agents get bitten:
        // they edit, then re-query). Count dirty files actually TOUCHED after the build — a dirty file
        // older than the graph was already part of it.
        try {
            const st = spawnSync('git', ['-C', ctx.repoRoot, 'status', '--porcelain'], {encoding: 'utf8', timeout: 4000, env: childProcessEnv()})
            if (st.status === 0) {
                let newer = 0
                for (const ln of String(st.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, 200)) {
                    const p = ln.slice(3).trim().replace(/^"|"$/g, '')
                    try { if (statSync(join(ctx.repoRoot, p)).mtime > info.builtAt) newer++ } catch { newer++ } // deleted counts as drift
                }
                info.dirtyNewer = newer
                if (newer > 0) info.stale = true
            }
        } catch { /* git unavailable */ }
    }
    stalenessCache = {key: ctx.graphPath, checkedAt: now, info}
    return info
}
export const resetStalenessCache = () => { stalenessCache = {key: '', checkedAt: 0, info: null} }
export function stalenessLine(ctx) {
    const s = graphStaleness(ctx)
    if (!s.stale) return null
    const bits = []
    if (s.headAt && s.headAt > s.builtAt) bits.push(`${s.behind != null ? `${s.behind} commit${s.behind === 1 ? '' : 's'}` : 'commits'} newer than the graph`)
    if (s.dirtyNewer) bits.push(`${s.dirtyNewer} uncommitted file(s) edited after the build`)
    return `Warning: graph may be stale — the repo has ${bits.join(' and ')} (built ${s.builtAt.toISOString()}). Line numbers may have drifted; call rebuild_graph.`
}

// Per-file drift check for tools that print exact line numbers: the global warning says the REPO
// moved; this says THIS file moved — the difference between "be careful" and "these numbers are off".
export function fileStalenessNote(ctx, sourceFile) {
    if (!ctx?.repoRoot || !sourceFile) return null
    const s = graphStaleness(ctx)
    if (!s.builtAt) return null
    try {
        const resolved = resolveRepoPath(ctx.repoRoot, String(sourceFile))
        if (resolved.ok && statSync(resolved.path).mtime > s.builtAt) {
            return `Note: ${sourceFile} changed after the graph was built — line numbers above may have drifted (rebuild_graph refreshes them).`
        }
    } catch { /* file gone — the read tools will surface that themselves */ }
    return null
}

// Raw graph.json (with externalImports, file_type, source_end …) for the analysis modules — the MCP's
// own loadGraph struct strips those fields. Cached by mtime; rebuild_graph changes the mtime → refresh.
let rawGraphCache = {path: '', mtimeMs: 0, data: null}
export function rawGraph(ctx) {
    const mtimeMs = statSync(ctx.graphPath).mtimeMs
    if (!rawGraphCache.data || rawGraphCache.path !== ctx.graphPath || rawGraphCache.mtimeMs !== mtimeMs) {
        rawGraphCache = {path: ctx.graphPath, mtimeMs, data: JSON.parse(readFileSync(ctx.graphPath, 'utf8'))}
    }
    return rawGraphCache.data
}

export {prevGraphPathFor, edgeEndpoint, fileOfId, diffGraphs, formatGraphDiff} from './graph-diff.mjs'
