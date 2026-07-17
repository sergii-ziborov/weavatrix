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
import {mergePrecisionOverlay, precisionSemanticInputsMatch, readPrecisionOverlay} from '../precision/lsp-overlay.js'
import {createPathClassifier, hasPathClass} from '../path-classification.js'

// ---- graph load + indexes -----------------------------------------------------------------------
export function loadGraph(path, {repoRoot = null} = {}) {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    const overlay = readPrecisionOverlay(path, saved)
    const safeOverlay = repoRoot && typeof overlay?.semanticInputFingerprint === 'string'
        && !precisionSemanticInputsMatch(overlay, repoRoot, saved)
        ? null : overlay
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
    ['bootstrap', ['bootstrap', 'startup', 'entrypoint', 'entry', 'main', 'root', 'app', 'application', 'applications', 'index', 'server', 'cli']],
    ['tool-execution', ['tool', 'tools', 'tooling', 'mcp', 'execution', 'execute', 'invocation', 'invoke', 'dispatch', 'dispatcher', 'handler', 'catalog', 'registry']],
    ['auth', ['auth', 'authentication', 'authorization', 'login', 'session', 'authgate']],
    ['routing', ['routing', 'router', 'routes', 'route', 'navigation']],
    ['layout', ['layout', 'layouts', 'shell']],
    ['api', ['api', 'apis', 'endpoint', 'endpoints', 'client']],
    ['state', ['state', 'store', 'stores', 'reducer', 'context']],
]
const INTENT_BY_TERM = new Map(QUERY_INTENTS
    .filter(([id]) => id !== 'tool-execution')
    .flatMap(([id, terms]) => terms.map((term) => [term, {id, terms}])))
const TOOL_EXECUTION_TERMS = QUERY_INTENTS.find(([id]) => id === 'tool-execution')[1]
const TOOL_EXECUTION_TRIGGERS = new Set(['tool', 'tools', 'tooling', 'mcp'])
const wordsOf = (value) => String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
const normPath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
const NON_PRODUCT_CLASSES = Object.freeze(['test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp'])
const CLASS_QUERY_TERMS = Object.freeze({
    test: ['test', 'tests', 'testing', 'spec', 'specs', 'unit'],
    e2e: ['e2e', 'playwright', 'cypress'],
    generated: ['generated', 'autogenerated', 'dist'],
    mock: ['mock', 'mocks', 'fixture', 'fixtures', 'fake'],
    story: ['story', 'stories', 'storybook'],
    docs: ['doc', 'docs', 'documentation', 'readme', 'guide'],
    benchmark: ['benchmark', 'benchmarks', 'bench'],
    temp: ['temp', 'temporary', 'tmp'],
})
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|java|rs|kt|kts|cs|rb|php)$/i
const DATA_OR_PROSE_RE = /\.(?:json|ya?ml|toml|ini|md|mdx|rst|adoc|html?|css|scss|less|svg)$/i

const sourceFileOf = (node) => {
    const source = node?.source_file || String(node?.id ?? '').split('#', 1)[0]
    return normPath(source)
}

function requestedPathClasses(query) {
    const words = new Set(wordsOf(query))
    const requested = new Set()
    for (const [category, terms] of Object.entries(CLASS_QUERY_TERMS)) {
        if (terms.some((term) => words.has(term))) requested.add(category)
    }
    // E2E is also classified as test. Conversely, a broad request for tests should be allowed to
    // surface all test kinds instead of silently hiding integration/e2e files.
    if (requested.has('test')) requested.add('e2e')
    if (requested.has('e2e')) requested.add('test')
    return requested
}

function isQueryEligible(node, requestedClasses, classificationCache, classifier) {
    const source = sourceFileOf(node)
    if (!source) return true
    // Query ranking needs path/config classes, not generated-header inspection. Supplying bounded
    // content avoids opening every source file in a large repository merely to choose a few seeds.
    if (!classificationCache.has(source)) classificationCache.set(source, classifier.explain(source, {content: ''}))
    const info = classificationCache.get(source)
    const classified = NON_PRODUCT_CLASSES.filter((category) => hasPathClass(info, category))
    return classified.length === 0 || classified.some((category) => requestedClasses.has(category))
}

// A graph query has no repository filesystem context, so it cannot safely execute package scripts or
// guess a package.json beside an arbitrary graph path. Prefer evidence already present in the graph:
// conventional executable paths, explicit entry metadata when a builder provides it, and entry-like
// topology (few importers, real outgoing runtime links).
function entrypointSignal(g, node, source, stem) {
    if (isSymbol(node.id) || !CODE_FILE_RE.test(source)) return 0
    const segments = source.split('/')
    const depth = segments.length
    let score = 0
    if (node.entrypoint === true || node.is_entrypoint === true || node.declared_entry === true) score = 72
    if (/^bin\//.test(source) || /\/(?:bin|cmd)\//.test(source)) score = Math.max(score, 62)
    if (depth <= 2 && /^(?:index|main|app|server|cli|bootstrap|entry|run)$/.test(stem)) score = Math.max(score, 60)
    if (depth <= 2 && /(?:^|[-_.])(?:main|server|cli|bootstrap|entry)(?:$|[-_.])/.test(stem)) score = Math.max(score, 57)
    if (depth <= 3 && /^(?:main|app|server|cli|bootstrap|entry|run)$/.test(stem)) score = Math.max(score, 52)
    const incoming = uniqueConnCount(g.inn.get(String(node.id)))
    const outgoing = uniqueConnCount(g.out.get(String(node.id)))
    if (score && incoming === 0 && outgoing > 0) score += Math.min(7, 2 + outgoing)
    return score
}

function toolExecutionSignal(node, source, words, stem) {
    if (!CODE_FILE_RE.test(source)) return 0
    let score = 0
    if (/(^|\/)(?:mcp(?:[-_.][^/]*)?|tools?)(?:\/|[-_.])/.test(source)) score = Math.max(score, 51)
    // Dispatch/catalog files explain how the tool set is assembled and invoked; individual
    // `tools-*` modules explain only one capability. Prefer the control plane for broad questions.
    if (/^(?:catalog|dispatch(?:er)?|registry)$/.test(stem)) score = Math.max(score, 68)
    if (/^(?:tool[-_.]?(?:handler|runner|executor)|tools?[-_.])/.test(stem)) score = Math.max(score, 55)
    if ([...words].some((word) => /^(?:dispatch|dispatcher|toolcall|toolhandler|executetool|invoketool|calltool)$/.test(word))) score = Math.max(score, 64)
    if (source.includes('/mcp/') || stem.includes('mcp-server')) score = Math.max(score, 48)
    return score
}

function queryConcepts(query) {
    const tokens = wordsOf(query)
    const toolExecution = tokens.some((token) => TOOL_EXECUTION_TRIGGERS.has(token))
    const explanatoryWork = tokens.some((token) => token === 'how' || token === 'explain')
    const seen = new Set()
    const concepts = []
    for (const raw of tokens) {
        if (raw.length < 2 || QUERY_STOP.has(raw)) continue
        if (explanatoryWork && (raw === 'work' || raw === 'works' || raw === 'working')) continue
        if (toolExecution && TOOL_EXECUTION_TERMS.includes(raw)) {
            if (seen.has('tool-execution')) continue
            const trigger = tokens.find((token) => TOOL_EXECUTION_TRIGGERS.has(token)) || raw
            seen.add('tool-execution')
            concepts.push({id: 'tool-execution', raw: trigger, terms: [trigger, ...TOOL_EXECUTION_TERMS.filter((term) => term !== trigger)]})
            continue
        }
        const intent = INTENT_BY_TERM.get(raw)
        const id = intent?.id || raw
        if (seen.has(id)) continue
        seen.add(id)
        concepts.push({id, raw, terms: intent ? [raw, ...intent.terms.filter((term) => term !== raw)] : [raw]})
    }
    return concepts
}

function conceptScore(g, node, concept, queryContext) {
    const id = normPath(node.id)
    const label = String(node.label ?? '').toLowerCase()
    const source = sourceFileOf(node)
    const stem = (label.split('/').pop() || '').replace(/\.[^.]+$/, '')
    const words = new Set(wordsOf(`${node.id} ${node.label ?? ''} ${node.source_file ?? ''}`))
    const segments = new Set(source.split('/').flatMap((part) => wordsOf(part.replace(/\.[^.]+$/, ''))))
    let match = 0
    concept.terms.forEach((term, index) => {
        const primary = index === 0
        if (label === term || stem === term) match = Math.max(match, primary ? 60 : 42)
        else if (segments.has(term)) match = Math.max(match, primary ? 48 : 36)
        else if (words.has(term)) match = Math.max(match, primary ? 36 : 25)
        else if (term.length >= 4 && term !== 'tool' && term !== 'tools' && (id.includes(term) || label.includes(term))) match = Math.max(match, primary ? 12 : 7)
    })
    const fileNode = !isSymbol(node.id)
    const depth = source ? source.split('/').length : 9
    if (concept.id === 'bootstrap') match = Math.max(match, entrypointSignal(g, node, source, stem))
    if (concept.id === 'tool-execution') match = Math.max(match, toolExecutionSignal(node, source, words, stem))
    if (!match) return 0
    let score = match + (fileNode ? 7 : 0) + Math.max(0, 4 - depth) + Math.min(2, degreeOf(g, node.id) / 40)
    if ((concept.id === 'bootstrap' || concept.id === 'tool-execution') && DATA_OR_PROSE_RE.test(source)) score -= 34
    if ((concept.id === 'bootstrap' || concept.id === 'tool-execution') && !fileNode) score -= 18
    if (queryContext.runtimeIntent && !queryContext.maintenanceIntent && /^(?:scripts?|tools?\/scripts?)\//.test(source)) score -= 32
    // A web/demo index can be a legitimate entry point, but it is not the server/tool entry point of
    // a backend/tool-execution question. Keep it queryable for explicit UI/site questions while
    // preventing it from beating the executable and dispatcher merely because its basename is index.
    if (queryContext.runtimeIntent && /^(?:site|website|public|static|assets)\//.test(source)) score -= 28
    return Math.max(0, score)
}

// Natural-language graph search keeps one strong candidate per concept before filling by aggregate
// score. This prevents a broad architecture question from spending every seed on one dense API area.
export function findSeeds(g, query, limit = 8, {repoRoot = null} = {}) {
    const concepts = queryConcepts(query)
    if (!concepts.length || limit <= 0) return []
    const requestedClasses = requestedPathClasses(query)
    const queryContext = {
        runtimeIntent: concepts.some((concept) => concept.id === 'bootstrap' || concept.id === 'tool-execution'),
        maintenanceIntent: wordsOf(query).some((word) => ['script', 'scripts', 'build', 'release', 'publish', 'packaging'].includes(word)),
    }
    const classifier = createPathClassifier(repoRoot)
    const classificationCache = new Map()
    const rows = g.nodes.filter((node) => isQueryEligible(node, requestedClasses, classificationCache, classifier)).map((node) => {
        const scores = concepts.map((concept) => conceptScore(g, node, concept, queryContext))
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

// Consumers that need semantic precision use the revision-matched effective graph. Structural Git
// baselines and graph_diff deliberately keep using rawGraph so provider availability cannot fabricate
// architecture drift.
export function effectiveRawGraph(ctx) {
    const raw = rawGraph(ctx)
    const overlay = readPrecisionOverlay(ctx.graphPath, raw)
    const safeOverlay = ctx?.repoRoot && typeof overlay?.semanticInputFingerprint === 'string'
        && !precisionSemanticInputsMatch(overlay, ctx.repoRoot, raw)
        ? null : overlay
    return mergePrecisionOverlay(raw, safeOverlay)
}

export {prevGraphPathFor, edgeEndpoint, fileOfId, diffGraphs, formatGraphDiff} from './graph-diff.mjs'
