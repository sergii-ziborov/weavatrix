// Shared graph core for the MCP tool modules: graph loading + indexes, node resolution, staleness,
// the raw-graph cache, and the structural diff helpers. This module holds process-lifetime CACHES
// (staleness, raw graph), so every tool module imports it STATICALLY — it is the one part of src/mcp
// that does NOT hot-reload (editing it needs an MCP reconnect, same as the analysis engines).
import {readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../child-env.js'
import {buildFileImportGraph, findSccs} from '../analysis/dep-rules.js'
import {resolveRepoPath} from '../repo-path.js'

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
            ...(e.typeOnly === true ? {typeOnly: true} : {}),
            ...(Number.isInteger(e.line) ? {line: e.line} : {}),
            ...(typeof e.specifier === 'string' ? {specifier: e.specifier} : {}),
        }
        push(out, s, {id: t, ...metadata})
        push(inn, t, {id: s, ...metadata})
    }
    return {
        nodes, links, byId, byLabel, out, inn,
        repoBoundaryV: Number(raw.repoBoundaryV) || 0,
        edgeTypesV: Number(raw.edgeTypesV) || 0,
    }
}

export const isSymbol = (id) => String(id).includes('#')
export const degreeOf = (g, id) => (g.out.get(id)?.length || 0) + (g.inn.get(id)?.length || 0)
export const labelOf = (g, id) => {
    const n = g.byId.get(String(id))
    return n ? String(n.label ?? n.id) : String(id)
}

// "connectivity" degree ignores structural `contains` (parent→symbol nesting) so god_nodes surfaces real
// call/import/reference hubs, not just files that hold many symbols.
export const connList = (list) => (list || []).filter((e) => e.relation !== 'contains')
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

// seeds for traversal/search: rank substring/token matches by degree
export function findSeeds(g, query, limit = 8) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) return []
    const tokens = q.split(/[^a-z0-9_]+/i).filter((t) => t.length > 1)
    const scored = []
    for (const n of g.nodes) {
        const hay = `${String(n.id)} ${String(n.label ?? '')} ${String(n.source_file ?? '')}`.toLowerCase()
        let score = 0
        if (hay.includes(q)) score += 5
        for (const t of tokens) if (hay.includes(t)) score += 1
        if (score > 0) scored.push({n, score: score + Math.min(3, degreeOf(g, n.id) / 20)})
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.n)
}

// undirected adjacency for reachability (query/shortest path)
export function undirectedNeighbors(g, id) {
    const seen = new Map()
    for (const e of g.out.get(id) || []) seen.set(e.id, e.relation)
    for (const e of g.inn.get(id) || []) if (!seen.has(e.id)) seen.set(e.id, e.relation)
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

// ---- graph diff ----------------------------------------------------------------------------------
// One previous state is enough (4-13 MB per repo — cheap): rebuild_graph snapshots the outgoing
// graph.json as graph.prev.json and reports the structural delta inline, at the exact moment the fix
// is being verified. graph_diff re-queries the same pair later. Raw node/edge dumps would be noise —
// the signal is aggregated: module-dependency drift, cycle count changes, newly orphaned symbols.
export const prevGraphPathFor = (graphPath) => String(graphPath).replace(/\.json$/, '.prev.json')
export const edgeEndpoint = (v) => String(v && typeof v === 'object' ? v.id : v)
export const fileOfId = (id) => { const s = String(id); const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h) }
const folderOfFile = (file) => {
    const dirs = String(file || '').split(/[\\/]/).filter(Boolean).slice(0, -1)
    return dirs.length ? dirs.slice(0, 2).join('/') : '(root)'
}

// Works on anything with {nodes, links}: the raw graph.json shape and the loadGraph struct alike.
export function diffGraphs(oldG, newG) {
    const oldEdgeTypesV = Number(oldG.edgeTypesV) || 0
    const newEdgeTypesV = Number(newG.edgeTypesV) || 0
    const schemaMigration = oldEdgeTypesV !== newEdgeTypesV
    const nodeIds = (graph) => new Set((graph.nodes || []).map((n) => String(n.id)))
    const oldNodes = nodeIds(oldG)
    const newNodes = nodeIds(newG)

    const edgeKey = (l) => `${edgeEndpoint(l.source)}|${l.relation || ''}|${schemaMigration ? 'untyped' : l.typeOnly === true ? 'type' : 'runtime'}|${edgeEndpoint(l.target)}`
    const edgeSet = (graph) => new Set((graph.links || []).map(edgeKey))
    const oldEdges = edgeSet(oldG)
    const newEdges = edgeSet(newG)

    const moduleEdges = (graph, typeOnly) => {
        const set = new Set()
        for (const l of graph.links || []) {
            if (l.relation === 'contains') continue
            if ((l.typeOnly === true) !== typeOnly) continue
            const a = folderOfFile(fileOfId(edgeEndpoint(l.source)))
            const b = folderOfFile(fileOfId(edgeEndpoint(l.target)))
            if (a !== b) set.add(`${a} → ${b}`)
        }
        return set
    }
    const combinedModuleEdges = (graph) => {
        const set = new Set()
        for (const l of graph.links || []) {
            if (l.relation === 'contains') continue
            const a = folderOfFile(fileOfId(edgeEndpoint(l.source)))
            const b = folderOfFile(fileOfId(edgeEndpoint(l.target)))
            if (a !== b) set.add(`${a} → ${b}`)
        }
        return set
    }
    const oldMods = schemaMigration ? combinedModuleEdges(oldG) : moduleEdges(oldG, false)
    const newMods = schemaMigration ? combinedModuleEdges(newG) : moduleEdges(newG, false)
    const oldTypeMods = schemaMigration ? new Set() : moduleEdges(oldG, true)
    const newTypeMods = schemaMigration ? new Set() : moduleEdges(newG, true)

    const incoming = (graph) => {
        const m = new Map()
        for (const l of graph.links || []) {
            if (l.relation === 'contains') continue
            const t = edgeEndpoint(l.target)
            m.set(t, (m.get(t) || 0) + 1)
        }
        return m
    }
    const oldIn = incoming(oldG)
    const newIn = incoming(newG)

    const cycles = (graph, includeTypeOnly) => {
        try {
            const sccs = findSccs(buildFileImportGraph(graph, {includeTypeOnly}).adj)
                .map((members) => members.map(String).sort())
                .sort((a, b) => b.length - a.length || a.join('\n').localeCompare(b.join('\n')))
            return {
                count: sccs.length,
                largest: sccs[0]?.length || 0,
                groups: sccs,
            }
        } catch {
            return null
        }
    }
    const cycleDelta = (before, after) => {
        if (!before || !after) return null
        const key = (group) => group.join('|')
        const beforeKeys = new Set(before.groups.map(key))
        const afterKeys = new Set(after.groups.map(key))
        const overlap = (a, b) => {
            const bSet = new Set(b)
            return a.reduce((n, member) => n + (bSet.has(member) ? 1 : 0), 0)
        }
        const unmatchedBefore = before.groups.filter((group) => !afterKeys.has(key(group)))
        const unmatchedAfter = after.groups.filter((group) => !beforeKeys.has(key(group)))
        const changed = unmatchedAfter.filter((group) => unmatchedBefore.some((old) => overlap(group, old) >= 2))
        const introduced = unmatchedAfter.filter((group) => !unmatchedBefore.some((old) => overlap(group, old) >= 2))
        const resolved = unmatchedBefore.filter((group) => !unmatchedAfter.some((next) => overlap(group, next) >= 2))
        return {
            before: before.count,
            after: after.count,
            largestBefore: before.largest,
            largestAfter: after.largest,
            introduced: introduced.map(key),
            resolved: resolved.map(key),
            membershipChanged: changed.length,
        }
    }

    return {
        schemaMigration: schemaMigration ? {from: oldEdgeTypesV, to: newEdgeTypesV} : null,
        nodes: {
            added: [...newNodes].filter((id) => !oldNodes.has(id)),
            removed: [...oldNodes].filter((id) => !newNodes.has(id))
        },
        edges: {
            added: [...newEdges].filter((k) => !oldEdges.has(k)).length,
            removed: [...oldEdges].filter((k) => !newEdges.has(k)).length
        },
        moduleEdges: {
            added: [...newMods].filter((k) => !oldMods.has(k)),
            removed: [...oldMods].filter((k) => !newMods.has(k)),
            typeAdded: [...newTypeMods].filter((k) => !oldTypeMods.has(k)),
            typeRemoved: [...oldTypeMods].filter((k) => !newTypeMods.has(k)),
        },
        // survived the rebuild but lost every caller/importer — likely made dead by the change
        orphaned: [...oldIn.keys()].filter((id) => newNodes.has(id) && !newIn.has(id)),
        cycles: {
            runtime: schemaMigration ? null : cycleDelta(cycles(oldG, false), cycles(newG, false)),
            typeInclusive: schemaMigration ? null : cycleDelta(cycles(oldG, true), cycles(newG, true)),
        }
    }
}

export function formatGraphDiff(d) {
    if (!d.nodes.added.length && !d.nodes.removed.length && !d.edges.added && !d.edges.removed) {
        return d.schemaMigration
            ? `Graph edge schema upgraded v${d.schemaMigration.from} → v${d.schemaMigration.to}; typed baseline established. Runtime/type cycle and module classifications are intentionally not compared on this rebuild.`
            : 'No structural change between the two graph states.'
    }
    const cap = (list, n) => list.slice(0, n).map((x) => `  ${x}`).concat(list.length > n ? [`  … +${list.length - n} more`] : [])
    const lines = [`Structural delta: nodes +${d.nodes.added.length}/−${d.nodes.removed.length}, edges +${d.edges.added}/−${d.edges.removed}.`]
    if (d.schemaMigration) lines.push(`Graph edge schema upgraded v${d.schemaMigration.from} → v${d.schemaMigration.to}; runtime/type cycle and module classifications are intentionally not compared until the next rebuild.`)
    const runtime = d.cycles?.runtime
    if (runtime && (runtime.before !== runtime.after || runtime.largestBefore !== runtime.largestAfter || runtime.introduced.length || runtime.resolved.length || runtime.membershipChanged)) {
        const changes = []
        if (runtime.introduced.length) changes.push(`${runtime.introduced.length} genuinely new runtime SCC(s) — review`)
        if (runtime.resolved.length) changes.push(`${runtime.resolved.length} runtime SCC(s) resolved`)
        if (runtime.membershipChanged) changes.push(`${runtime.membershipChanged} SCC membership change(s)`)
        const verdict = changes.length ? `; ${changes.join('; ')}` : ''
        lines.push(`Runtime import cycles: count ${runtime.before} → ${runtime.after}, largest SCC ${runtime.largestBefore} → ${runtime.largestAfter}${verdict}.`)
    }
    const all = d.cycles?.typeInclusive
    if (all && (all.before !== all.after || all.largestBefore !== all.largestAfter) &&
        (!runtime || all.before !== runtime.before || all.after !== runtime.after || all.largestBefore !== runtime.largestBefore || all.largestAfter !== runtime.largestAfter)) {
        lines.push(`Type-inclusive dependency SCCs: count ${all.before} → ${all.after}, largest ${all.largestBefore} → ${all.largestAfter} (compile-time coupling, not necessarily a runtime cycle).`)
    }
    if (d.moduleEdges.added.length) lines.push('NEW module dependencies (architecture drift — review):', ...cap(d.moduleEdges.added, 12))
    if (d.moduleEdges.removed.length) lines.push('Removed module dependencies (decoupling confirmed):', ...cap(d.moduleEdges.removed, 12))
    if (d.moduleEdges.typeAdded.length) lines.push('New type-only module dependencies (compile-time coupling):', ...cap(d.moduleEdges.typeAdded, 12))
    if (d.moduleEdges.typeRemoved.length) lines.push('Removed type-only module dependencies:', ...cap(d.moduleEdges.typeRemoved, 12))
    if (d.orphaned.length) lines.push('Symbols that lost their last caller/importer (now dead?):', ...cap(d.orphaned, 10))
    if (d.nodes.added.length) lines.push('Added nodes:', ...cap(d.nodes.added, 12))
    if (d.nodes.removed.length) lines.push('Removed nodes:', ...cap(d.nodes.removed, 12))
    return lines.join('\n')
}
