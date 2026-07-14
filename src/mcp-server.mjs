// weavatrix MCP server — the stdio server over a repo's graph.json plus the analysis engines.
// Spawned by Claude Code / Codex as a plain Node child (node mcp-server.mjs <graph.json> <repoRoot>).
// Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
// Tools: graph_stats, get_node, get_neighbors, query_graph, god_nodes, shortest_path, get_community,
// get_dependents (transitive reverse-dependency blast radius), change_impact (diff/PR-file-list blast
// radius with coverage), graph_diff (structural delta of the last rebuild), list_communities,
// module_map, search_code (ripgrep-backed), read_source, run_audit (dead code, dependency health,
// cycles/orphans, offline supply-chain), coverage_map, list_endpoints, plus rebuild_graph, open_repo /
// list_known_repos (one running server retargets any local repo). Graph tools self-report staleness
// vs the repo HEAD.
//
// .mjs on purpose: guarantees ESM parsing regardless of the nearest package.json. The server itself
// resolves nothing from node_modules at runtime (ripgrep is probed, with a pure-Node fallback); only
// the graph BUILDER pulls in web-tree-sitter + its WASM grammars when a build is requested.
//
// STDOUT is the protocol channel — nothing but JSON-RPC frames may be written there. All diagnostics go to
// stderr. argv: [0]=node, [1]=this script, [2]=graph.json, [3]=repo root (optional, enables source tools).
import {readFileSync, writeFileSync, existsSync, statSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import process from 'node:process'
import { createRgResolver } from './mcp-rg.mjs'
import { readSource, searchCode } from './mcp-source-tools.mjs'
import { buildGraphForRepo } from './build-graph.js'
import { computeDuplicates } from './analysis/duplicates.js'
import { runInternalAudit } from './analysis/internal-audit.js'
import { summarizeCommunities, aggregateGraph } from './analysis/graph-analysis.js'
import { detectEndpoints } from './analysis/endpoints.js'
import { readCoverageForRepo } from './analysis/coverage-reports.js'
import { buildFileImportGraph, findSccs } from './analysis/dep-rules.js'
import { graphOutDirForRepo } from './graph/layout.js'

const SELF_DIR = dirname(fileURLToPath(import.meta.url)) // packaged: resources/app.asar.unpacked/main/repos
const resolveRg = createRgResolver(SELF_DIR)
const SERVER_INFO = {name: 'weavatrix', version: '0.0.1'}
const DEFAULT_PROTOCOL = '2024-11-05'
const log = (...a) => process.stderr.write(`[weavatrix] ${a.join(' ')}\n`)

// ---- graph load + indexes -----------------------------------------------------------------------
function loadGraph(path) {
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
        push(out, s, {id: t, relation: e.relation, confidence: e.confidence})
        push(inn, t, {id: s, relation: e.relation, confidence: e.confidence})
    }
    return {nodes, links, byId, byLabel, out, inn}
}

const isSymbol = (id) => String(id).includes('#')
const degreeOf = (g, id) => (g.out.get(id)?.length || 0) + (g.inn.get(id)?.length || 0)
const labelOf = (g, id) => {
    const n = g.byId.get(String(id))
    return n ? String(n.label ?? n.id) : String(id)
}

// repo source root (argv[3]) for search_code / read_source; null → those tools degrade. Resolved at
// module scope (not in main) so hot-reloaded copies of this module compute it too — see HOT_API below.
const REPO_ROOT = process.argv[3] && existsSync(process.argv[3]) ? process.argv[3] : null
// "connectivity" degree ignores structural `contains` (parent→symbol nesting) so god_nodes surfaces real
// call/import/reference hubs, not just files that hold many symbols.
const connList = (list) => (list || []).filter((e) => e.relation !== 'contains')

// Resolve a user-supplied "label" to a node: exact id → exact label → ci label → substring (best degree).
// Returns {node, matches, alternates} so callers can disclose ambiguity instead of silently picking one.
function resolveNodeInfo(g, query) {
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
const resolveNode = (g, query) => resolveNodeInfo(g, query).node
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
function ambiguityNote(query, info) {
    if (!info.node || info.matches <= 1) return null
    const more = info.matches - 1 - info.alternates.length
    return `Note: "${query}" matched ${info.matches} nodes; using the best-connected. Others: ${info.alternates.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
}
const bestByDegree = (g, list) =>
    list.reduce((best, n) => (degreeOf(g, n.id) > degreeOf(g, best.id) ? n : best), list[0])

// seeds for traversal/search: rank substring/token matches by degree
function findSeeds(g, query, limit = 8) {
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

// ---- staleness ----------------------------------------------------------------------------------
// The graph is a point-in-time build of graph.json; without a freshness signal an agent cannot tell
// whether answers reflect the current code. Compare graph.json mtime with the repo's latest commit
// (cheap `git log -1`), cached for 60s so per-tool warnings don't spawn git on every call.
let stalenessCache = {key: '', checkedAt: 0, info: null}
function graphStaleness(ctx) {
    const now = Date.now()
    if (stalenessCache.info && stalenessCache.key === ctx.graphPath && now - stalenessCache.checkedAt < 60_000) return stalenessCache.info
    const info = {builtAt: null, headAt: null, stale: false, behind: null}
    try { info.builtAt = statSync(ctx.graphPath).mtime } catch { /* no graph file — nothing to report */ }
    if (ctx.repoRoot && info.builtAt) {
        try {
            const head = spawnSync('git', ['-C', ctx.repoRoot, 'log', '-1', '--format=%cI'], {encoding: 'utf8', timeout: 4000})
            const iso = (head.stdout || '').trim()
            if (head.status === 0 && iso) {
                info.headAt = new Date(iso)
                if (info.headAt > info.builtAt) {
                    info.stale = true
                    const cnt = spawnSync('git', ['-C', ctx.repoRoot, 'rev-list', '--count', `--since=${info.builtAt.toISOString()}`, 'HEAD'], {encoding: 'utf8', timeout: 4000})
                    if (cnt.status === 0) info.behind = Number(cnt.stdout.trim()) || null
                }
            }
        } catch { /* git unavailable — degrade to builtAt only */ }
    }
    stalenessCache = {key: ctx.graphPath, checkedAt: now, info}
    return info
}
const resetStalenessCache = () => { stalenessCache = {key: '', checkedAt: 0, info: null} }
function stalenessLine(ctx) {
    const s = graphStaleness(ctx)
    if (!s.stale) return null
    const behind = s.behind != null ? `${s.behind} commit${s.behind === 1 ? '' : 's'}` : 'commits'
    return `Warning: graph may be stale — the repo has ${behind} newer than the graph (built ${s.builtAt.toISOString()}). Call rebuild_graph.`
}

// ---- tools --------------------------------------------------------------------------------------
function tGraphStats(g, ctx) {
    const files = g.nodes.filter((n) => !isSymbol(n.id)).length
    const symbols = g.nodes.length - files
    const relCount = {}
    const confCount = {}
    for (const e of g.links) {
        relCount[e.relation ?? '?'] = (relCount[e.relation ?? '?'] || 0) + 1
        if (e.confidence != null) confCount[e.confidence] = (confCount[e.confidence] || 0) + 1
    }
    const comm = new Map()
    for (const n of g.nodes) {
        const c = n.community ?? 'none'
        comm.set(c, (comm.get(c) || 0) + 1)
    }
    const topComm = [...comm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    const fmt = (o) =>
        Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')
    const freshness = ctx ? graphStaleness(ctx) : null
    return [
        `Graph summary`,
        ctx?.repoRoot ? `- Repo: ${ctx.repoRoot}` : null,
        `- Nodes: ${g.nodes.length} (${files} files, ${symbols} symbols)`,
        `- Edges: ${g.links.length}`,
        `- Relations: ${fmt(relCount)}`,
        Object.keys(confCount).length ? `- Confidence: ${fmt(confCount)}` : null,
        `- Communities: ${comm.size} (top by size: ${topComm.map(([c, n]) => `#${c}=${n}`).join(', ')})`,
        freshness?.builtAt ? `- Built: ${freshness.builtAt.toISOString()}${freshness.headAt ? ` (repo HEAD committed ${freshness.headAt.toISOString()})` : ''}` : null,
    ]
        .filter(Boolean)
        .join('\n')
}

function tGetNode(g, {label} = {}) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const id = String(n.id)
    const outs = g.out.get(id) || []
    const ins = g.inn.get(id) || []
    const sample = (list, dir) =>
        list
            .slice(0, 12)
            .map((e) => `  ${dir === 'out' ? '→' : '←'} ${e.relation || 'rel'}  ${labelOf(g, e.id)}  [${e.id}]`)
            .join('\n') || '  (none)'
    return [
        note,
        `Node: ${n.label ?? id}`,
        `- id: ${id}`,
        `- kind: ${isSymbol(id) ? 'symbol' : 'file'}${n.file_type ? ` (${n.file_type})` : ''}`,
        n.source_file ? `- source: ${n.source_file}${n.source_location ? ` ${n.source_location}` : ''}` : null,
        n.community != null ? `- community: ${n.community}` : null,
        `- degree: ${outs.length + ins.length} (out ${outs.length}, in ${ins.length})`,
        `Outgoing:\n${sample(outs, 'out')}`,
        `Incoming:\n${sample(ins, 'in')}`,
    ]
        .filter(Boolean)
        .join('\n')
}

// Collapse repeated edges to the same neighbor (one per call site in the graph) into `(N sites)` —
// a hub function's caller list shrinks ~2-3x with no information loss.
function dedupeEdges(list) {
    const grouped = new Map()
    for (const e of list) {
        const key = `${e.relation || 'rel'}|${e.id}`
        const cur = grouped.get(key)
        if (cur) cur.count += 1
        else grouped.set(key, {id: e.id, relation: e.relation, count: 1})
    }
    return [...grouped.values()]
}

function tGetNeighbors(g, {label, relation_filter} = {}) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const id = String(n.id)
    const rf = relation_filter ? String(relation_filter).toLowerCase() : null
    const match = (e) => !rf || String(e.relation ?? '').toLowerCase() === rf
    const outsRaw = (g.out.get(id) || []).filter(match)
    const insRaw = (g.inn.get(id) || []).filter(match)
    const outs = dedupeEdges(outsRaw)
    const ins = dedupeEdges(insRaw)
    const line = (e, dir) =>
        `  ${dir === 'out' ? '→' : '←'} ${e.relation || 'rel'}  ${labelOf(g, e.id)}  [${e.id}]${e.count > 1 ? `  (${e.count} sites)` : ''}`
    return [
        note,
        `Neighbors of ${n.label ?? id}${rf ? ` (relation=${rf})` : ''}: ${outs.length + ins.length} unique (${outsRaw.length + insRaw.length} edges)`,
        `Outgoing (${outs.length}):`,
        ...outs.slice(0, 60).map((e) => line(e, 'out')),
        `Incoming (${ins.length}):`,
        ...ins.slice(0, 60).map((e) => line(e, 'in')),
    ].filter(Boolean).join('\n')
}

function tGodNodes(g, {top_n = 10} = {}) {
    const n = Math.max(1, Math.min(100, Number(top_n) || 10))
    const ranked = g.nodes
        .map((node) => {
            const o = connList(g.out.get(String(node.id))).length
            const i = connList(g.inn.get(String(node.id))).length
            return {node, deg: o + i, out: o, in: i}
        })
        .sort((a, b) => b.deg - a.deg)
        .slice(0, n)
    return [
        `Top ${n} most-connected nodes (call/import/reference edges, excluding structural containment):`,
        ...ranked.map(
            (r, i) =>
                `${String(i + 1).padStart(2)}. ${r.node.label ?? r.node.id}  (${r.deg} edges: out ${r.out}, in ${r.in})  [${r.node.id}]`
        ),
    ].join('\n')
}

function tGetCommunity(g, {community_id} = {}) {
    const groups = new Map()
    for (const node of g.nodes) {
        const c = node.community
        if (c == null) continue
        if (!groups.has(c)) groups.set(c, [])
        groups.get(c).push(node)
    }
    const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length) // 0-indexed by size
    const idx = Number(community_id)
    if (!Number.isInteger(idx) || idx < 0 || idx >= ranked.length)
        return `Invalid community_id ${community_id}. Valid range 0..${ranked.length - 1} (0 = largest).`
    const [rawId, members] = ranked[idx]
    const files = members.filter((m) => !isSymbol(m.id))
    return [
        `Community #${idx} (raw id ${rawId}) — ${members.length} nodes, ${files.length} files:`,
        ...members
            .slice()
            .sort((a, b) => degreeOf(g, b.id) - degreeOf(g, a.id))
            .slice(0, 80)
            .map((m) => `  ${m.label ?? m.id}  [${m.id}]`),
        members.length > 80 ? `  … +${members.length - 80} more` : null,
    ]
        .filter(Boolean)
        .join('\n')
}

// undirected adjacency for reachability (query/shortest path)
function undirectedNeighbors(g, id) {
    const seen = new Map()
    for (const e of g.out.get(id) || []) seen.set(e.id, e.relation)
    for (const e of g.inn.get(id) || []) if (!seen.has(e.id)) seen.set(e.id, e.relation)
    return seen
}

// A plain BFS/DFS flood dumps every reached node (thousands on a real graph) at near-zero signal.
// Instead: traverse to record reach + distance-from-seed, then show only the closest, most-connected
// slice as a coherent subgraph (edges kept only among shown nodes). Honest about what was trimmed.
function tQueryGraph(g, {question, mode = 'bfs', depth = 3, context_filter, token_budget = 2000} = {}) {
    const seeds = findSeeds(g, question, 6)
    if (!seeds.length) return `No nodes matched "${question}".`
    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3))
    const ctx = Array.isArray(context_filter) && context_filter.length ? new Set(context_filter.map((c) => String(c).toLowerCase())) : null
    const relOk = (rel) => !ctx || ctx.has(String(rel ?? '').toLowerCase())
    const charBudget = Math.max(400, (Number(token_budget) || 2000) * 4)
    // node budget scales gently with the token budget; edges follow the surviving nodes.
    const nodeBudget = Math.max(20, Math.min(120, Math.round((Number(token_budget) || 2000) / 40)))
    const depthOf = new Map() // id -> shortest distance from any seed
    const edges = []
    const start = seeds.map((s) => String(s.id))
    if (mode === 'dfs') {
        const stack = start.map((id) => ({id, d: 0}))
        const seen = new Set()
        while (stack.length) {
            const {id, d} = stack.pop()
            if (!depthOf.has(id) || d < depthOf.get(id)) depthOf.set(id, d)
            if (seen.has(id)) continue
            seen.add(id)
            if (d >= maxDepth) continue
            for (const [nid, rel] of undirectedNeighbors(g, id)) {
                if (!relOk(rel)) continue
                edges.push([id, rel, nid])
                if (!seen.has(nid)) stack.push({id: nid, d: d + 1})
            }
        }
    } else {
        let frontier = start.slice()
        start.forEach((id) => depthOf.set(id, 0))
        for (let d = 0; d < maxDepth && frontier.length; d++) {
            const next = []
            for (const id of frontier)
                for (const [nid, rel] of undirectedNeighbors(g, id)) {
                    if (!relOk(rel)) continue
                    edges.push([id, rel, nid])
                    if (!depthOf.has(nid)) {
                        depthOf.set(nid, d + 1)
                        next.push(nid)
                    }
                }
            frontier = next
        }
    }
    // rank reached nodes: seeds first, then by proximity (depth asc), then connectivity (degree desc)
    const ranked = [...depthOf.entries()]
        .map(([id, d]) => ({id, d, deg: degreeOf(g, id)}))
        .sort((a, b) => a.d - b.d || b.deg - a.deg)
    const shown = ranked.slice(0, nodeBudget)
    const shownIds = new Set(shown.map((n) => n.id))
    const edgeSeen = new Set()
    const shownEdges = []
    for (const [s, r, t] of edges) {
        if (!shownIds.has(s) || !shownIds.has(t)) continue
        const key = `${s}|${r}|${t}`
        if (edgeSeen.has(key)) continue
        edgeSeen.add(key)
        shownEdges.push([s, r, t])
        if (shownEdges.length >= 160) break
    }
    const head = [
        `Query: "${question}" (${mode}, depth ${maxDepth}${ctx ? `, context ${[...ctx].join('/')}` : ''})`,
        `Seeds: ${seeds.map((s) => s.label ?? s.id).join(', ')}`,
        `Reached ${depthOf.size} nodes; showing ${shown.length} closest by proximity + connectivity, ${shownEdges.length} edges among them.`,
        ``,
        `Nodes:`,
    ]
    const nodeLines = shown.map((n) => `  [d${n.d}] ${labelOf(g, n.id)}  (deg ${n.deg})  [${n.id}]`)
    const edgeLines = ['', 'Edges:', ...shownEdges.map(([s, r, t]) => `  ${labelOf(g, s)} --${r || 'rel'}--> ${labelOf(g, t)}`)]
    let text = [...head, ...nodeLines, ...edgeLines].join('\n')
    if (text.length > charBudget) text = text.slice(0, charBudget) + `\n... (truncated to ~${token_budget} tokens)`
    return text
}

function tShortestPath(g, {source, target, max_hops = 8} = {}) {
    const s = resolveNode(g, source)
    const t = resolveNode(g, target)
    if (!s) return `Source "${source}" not found.`
    if (!t) return `Target "${target}" not found.`
    const sid = String(s.id)
    const tid = String(t.id)
    if (sid === tid) return `Source and target are the same node: ${s.label ?? sid}.`
    const cap = Math.max(1, Math.min(20, Number(max_hops) || 8))
    const prev = new Map([[sid, null]])
    const relTo = new Map()
    let frontier = [sid]
    let hops = 0
    let found = false
    while (frontier.length && hops < cap && !found) {
        const next = []
        for (const id of frontier) {
            for (const [nid, rel] of undirectedNeighbors(g, id)) {
                if (prev.has(nid)) continue
                prev.set(nid, id)
                relTo.set(nid, rel)
                if (nid === tid) {
                    found = true
                    break
                }
                next.push(nid)
            }
            if (found) break
        }
        frontier = next
        hops++
    }
    if (!prev.has(tid)) return `No path found between "${s.label ?? sid}" and "${t.label ?? tid}" within ${cap} hops.`
    const path = []
    for (let cur = tid; cur != null; cur = prev.get(cur)) path.unshift(cur)
    const lines = path.map((id, i) => (i === 0 ? `  ${labelOf(g, id)}` : `  --${relTo.get(id) || 'rel'}--> ${labelOf(g, id)}`))
    return [`Shortest path (${path.length - 1} hops): ${s.label ?? sid} → ${t.label ?? tid}`, ...lines].join('\n')
}

// Transitive blast-radius: who is affected if this node changes. Walks REVERSE dependency edges
// (calls/imports/inherits — not structural `contains`) out to `depth`. For a symbol, also seeds its
// containing file, because importers depend on the file rather than the individual symbol.
function tGetDependents(g, {label, depth = 3, max_nodes = 40} = {}) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3))
    const cap = Math.max(5, Math.min(120, Number(max_nodes) || 40))
    const id = String(n.id)
    const seeds = new Set([id])
    let containingFile = null
    if (isSymbol(id)) {
        const container = (g.inn.get(id) || []).find((e) => e.relation === 'contains')
        if (container) {
            containingFile = String(container.id)
            seeds.add(containingFile)
        }
    }
    const depthOf = new Map([...seeds].map((s) => [s, 0]))
    const relOf = new Map()
    let frontier = [...seeds]
    for (let d = 0; d < maxDepth && frontier.length; d++) {
        const next = []
        for (const cur of frontier) {
            for (const e of g.inn.get(cur) || []) {
                if (e.relation === 'contains') continue // structural nesting is not a dependency
                const nid = String(e.id)
                if (depthOf.has(nid)) continue
                depthOf.set(nid, d + 1)
                relOf.set(nid, e.relation || 'rel')
                next.push(nid)
            }
        }
        frontier = next
    }
    const ranked = [...depthOf.entries()]
        .filter(([nid]) => !seeds.has(nid))
        .map(([nid, d]) => ({id: nid, d, deg: degreeOf(g, nid)}))
        .sort((a, b) => a.d - b.d || b.deg - a.deg)
    if (!ranked.length) return [note, `No dependents found for ${n.label ?? id} within depth ${maxDepth} — nothing in the graph calls, imports, or inherits it.`].filter(Boolean).join('\n')
    const shown = ranked.slice(0, cap)
    return [
        note,
        `Dependents of ${n.label ?? id} (reverse calls/imports/inherits, depth ≤${maxDepth}): ${ranked.length} found, showing ${shown.length} by proximity + connectivity.`,
        containingFile ? `Includes importers of its containing file ${labelOf(g, containingFile)}.` : null,
        ...shown.map((r) => `  [d${r.d}] ${relOf.get(r.id) || 'rel'}  ${labelOf(g, r.id)}  (deg ${r.deg})  [${r.id}]`),
    ].filter(Boolean).join('\n')
}

// ---- source search + read (repo-root backed) ------------------------------------------------------
// ---- duplication / build action tools (repo-root backed) — mutate or scan the repo, not just read the graph ----
// Group clone pairs (mirrors the Health tab's client-side dupCompute) into union-find families.
function groupClones(data, {simMin, tokMin, mode, skipTests}) {
    const frags = data.frags || []
    const elig = (i) => frags[i].n >= tokMin && (!skipTests || !frags[i].test)
    const pairs = (data.modes?.[mode] || []).filter(([i, j, s]) => s >= simMin && elig(i) && elig(j))
    const parent = new Map()
    const find = (x) => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r); return r }
    for (const [i, j] of pairs) { if (!parent.has(i)) parent.set(i, i); if (!parent.has(j)) parent.set(j, j); parent.set(find(i), find(j)) }
    const groups = new Map()
    for (const [i, j, s] of pairs) {
        const r = find(i)
        if (!groups.has(r)) groups.set(r, {members: new Set(), maxSim: 0})
        const g = groups.get(r); g.members.add(i); g.members.add(j); g.maxSim = Math.max(g.maxSim, s)
    }
    return [...groups.values()].map((g) => {
        const members = [...g.members].sort((a, b) => frags[b].n - frags[a].n)
        return {members: members.map((i) => frags[i]), maxSim: g.maxSim, tokens: members.reduce((n, i) => n + frags[i].n, 0)}
    }).sort((a, b) => b.tokens - a.tokens)
}

function tFindDuplicates(g, args, ctx) {
    if (!ctx.repoRoot) return 'Duplicate scan needs the repo root (not provided to this server).'
    const simMin = Math.min(100, Math.max(50, Number(args.min_similarity) || 80))
    const tokMin = Math.min(400, Math.max(30, Number(args.min_tokens) || 50))
    const mode = args.mode === 'strict' ? 'strict' : 'renamed'
    const skipTests = args.include_tests ? false : true
    const data = computeDuplicates(ctx.repoRoot, ctx.graphPath)
    const groups = groupClones(data, {simMin, tokMin, mode, skipTests})
    if (!groups.length) return `No clones at ≥${simMin}% similarity / ≥${tokMin} tokens (${mode} mode). Try lowering the thresholds.`
    const top = groups.slice(0, Math.min(30, Math.max(1, Number(args.top_n) || 15)))
    const lines = top.map((grp, k) => {
        const head = `${k + 1}. ${grp.members.length}× "${grp.members[0].label}" — ≤${grp.maxSim}% similar, ${grp.tokens} duplicated tokens`
        const sites = grp.members.slice(0, 8).map((f) => `     ${f.file}:${f.start}-${f.end}`)
        return [head, ...sites].join('\n')
    })
    return `Found ${groups.length} clone group(s) (${mode} mode, ≥${simMin}%, ≥${tokMin} tok). Top ${top.length}:\n\n${lines.join('\n\n')}\n\nUse read_source on any two sites to compare, then extract shared logic.`
}

// Raw graph.json (with externalImports, file_type, source_end …) for the analysis modules — the MCP's
// own loadGraph struct strips those fields. Cached by mtime; rebuild_graph changes the mtime → refresh.
let rawGraphCache = {path: '', mtimeMs: 0, data: null}
function rawGraph(ctx) {
    const mtimeMs = statSync(ctx.graphPath).mtimeMs
    if (!rawGraphCache.data || rawGraphCache.path !== ctx.graphPath || rawGraphCache.mtimeMs !== mtimeMs) {
        rawGraphCache = {path: ctx.graphPath, mtimeMs, data: JSON.parse(readFileSync(ctx.graphPath, 'utf8'))}
    }
    return rawGraphCache.data
}

const SEVERITY_RANK = {critical: 0, high: 1, medium: 2, low: 3, info: 4}

// Full internal health audit: dead code + unused exports, dependency findings (npm/go/py missing &
// unused deps), structure (import cycles / orphans / boundary rules), supply-chain (offline OSV
// advisories, typosquat, lockfile drift), optional malware heuristics.
async function tRunAudit(g, args, ctx) {
    if (!ctx.repoRoot) return 'Audit needs the repo root (not provided to this server).'
    const audit = await runInternalAudit(ctx.repoRoot, {
        graph: rawGraph(ctx),
        skipMalwareScan: !args.include_malware_scan, // greps installed packages — slow, so opt-in
    })
    if (!audit.ok) return `Audit failed: ${audit.error}`
    const minSev = SEVERITY_RANK[args.min_severity] ?? 4
    const cat = args.category ? String(args.category) : null
    const max = Math.max(1, Math.min(100, Number(args.max_findings) || 30))
    const filtered = audit.findings
        .filter((f) => (SEVERITY_RANK[f.severity] ?? 4) <= minSev)
        .filter((f) => !cat || f.category === cat)
    const shown = filtered.slice(0, max)
    const sev = audit.summary.bySeverity
    const bycat = audit.summary.byCategory
    const line = (f) => {
        const where = f.file ? `  (${f.file}${f.symbol ? ` ${f.symbol}` : ''})` : f.package ? `  (pkg ${f.package}${f.version ? `@${f.version}` : ''})` : ''
        return `  [${f.severity}/${f.confidence || '?'}] ${f.rule}: ${f.title}${where}${f.fixHint ? `\n      fix: ${f.fixHint}` : ''}`
    }
    return [
        `Internal audit of ${audit.repo} (${audit.scanned.files} files, ${audit.scanned.symbols} symbols, ${audit.scanned.externalImports} external imports; malware scan: ${audit.scanned.malwareScanMode}).`,
        `Severity: critical ${sev.critical}, high ${sev.high}, medium ${sev.medium}, low ${sev.low}, info ${sev.info}. Categories: unused ${bycat.unused}, structure ${bycat.structure}, vulnerability ${bycat.vulnerability}, malware ${bycat.malware}.`,
        `Structure: ${audit.structureReport?.cycles ?? 0} cycle(s), ${audit.structureReport?.orphans ?? 0} orphan(s). Dead: ${audit.deadReport.deadFiles} file(s), ${audit.deadReport.unusedExports} unused export(s).`,
        audit.scanned.advisoryDbDate ? `Advisory DB: ${audit.scanned.advisoryDbDate}.` : 'Advisory DB: never refreshed for this repo — known-vuln matching skipped.',
        ``,
        `Showing ${shown.length} of ${filtered.length} finding(s)${cat ? ` in category "${cat}"` : ''}${args.min_severity ? ` at ≥${args.min_severity}` : ''}:`,
        ...shown.map(line),
        filtered.length > shown.length ? `  … +${filtered.length - shown.length} more (raise max_findings or filter by category/min_severity)` : null,
    ].filter((x) => x != null).join('\n')
}

// Named module clusters: graph communities labeled by their dominant folder instead of bare numbers.
function tListCommunities(g, args, ctx) {
    const max = Math.max(1, Math.min(100, Number(args.top_n) || 20))
    const list = summarizeCommunities(ctx.graphPath, max)
    if (!list.length) return 'No communities found in the graph.'
    return [
        `Communities, largest first (list position = community_id for get_community):`,
        ...list.map((c, i) => `${String(i).padStart(3)}. ${c.name} — ${c.size} nodes (raw id ${c.id}; e.g. ${[...new Set(c.files)].join(', ')})`),
    ].join('\n')
}

// Folder-level architecture map: modules (top-two path segments) with file/symbol counts and the
// strongest module→module dependencies. Pure graph aggregation — no filesystem reads.
function tModuleMap(g, args, ctx) {
    const agg = aggregateGraph(rawGraph(ctx), null)
    const topN = Math.max(1, Math.min(60, Number(args.top_n) || 25))
    const mods = agg.modules.slice(0, topN)
    const edges = agg.moduleEdges.slice(0, Math.min(50, topN * 2))
    return [
        `Module map: ${agg.totals.files} files in ${agg.modules.length} folder-modules, ${agg.totals.moduleEdges} module edges. Top ${mods.length}:`,
        ...mods.map((m) => `  ${m.name} — ${m.fileCount} files, ${m.symbolCount} symbols`),
        ``,
        `Strongest module dependencies:`,
        ...edges.map((e) => `  ${e.from} → ${e.to}  (${e.count})`),
    ].join('\n')
}

// Coverage × graph: map an EXISTING coverage report (istanbul/lcov/coverage.py/Go — read offline,
// tests are never executed here) onto files and symbols, then rank refactor risk as
// connectivity × uncovered share. Pairs with get_dependents: many dependents + low coverage ⇒ write
// tests before changing. Coverage pcts in this layer are fractions (0..1).
function tCoverageMap(g, args, ctx) {
    if (!ctx.repoRoot) return 'Coverage mapping needs the repo root (not provided to this server).'
    const agg = aggregateGraph(rawGraph(ctx), ctx.repoRoot)
    const pathFilter = args.path ? String(args.path).replace(/\\/g, '/').replace(/\/+$/, '') : null
    const inScope = (p) => !pathFilter || p === pathFilter || String(p).startsWith(`${pathFilter}/`)
    const allFiles = agg.modules.flatMap((m) => m.files.filter((f) => inScope(f.path)))
    const measured = allFiles.filter((f) => f.coverage != null)
    if (!measured.length) {
        return [
            `No coverage report found${pathFilter ? ` for ${pathFilter}` : ''} — this tool reads existing reports, it does not run tests.`,
            'Generate one with the repo\'s own test runner, then call coverage_map again:',
            '  JS/TS:  npx vitest run --coverage   (or jest --coverage)',
            '  Python: pytest --cov --cov-report=json',
            '  Go:     go test ./... -coverprofile=coverage.out',
            'Read locations: coverage/coverage-summary.json, coverage/coverage-final.json, (coverage/)lcov.info, coverage.json, coverage.out.',
        ].join('\n')
    }
    const pctStr = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`)
    const sources = [...new Set(measured.map((f) => f.coverageSource).filter(Boolean))]
    const avg = measured.reduce((s, f) => s + f.coverage, 0) / measured.length
    const rollup = agg.modules
        .map((m) => {
            const withCov = m.files.filter((f) => f.coverage != null && inScope(f.path))
            if (!withCov.length) return null
            return {
                name: m.name,
                measured: withCov.length,
                total: m.files.filter((f) => inScope(f.path)).length,
                avg: withCov.reduce((s, f) => s + f.coverage, 0) / withCov.length,
            }
        })
        .filter(Boolean)
        .sort((a, b) => a.avg - b.avg)
    const topN = Math.max(1, Math.min(50, Number(args.top_n) || 15))
    // risk = graph degree × uncovered share; only symbols below 80% matter
    const risky = agg.symbols
        .filter((s) => s.coverage != null && s.coverage < 0.8 && inScope(s.file))
        .map((s) => ({...s, degree: degreeOf(g, s.id)}))
        .filter((s) => s.degree > 0)
        .sort((a, b) => b.degree * (1 - b.coverage) - a.degree * (1 - a.coverage))
        .slice(0, topN)
    return [
        `Coverage map (${measured.length}/${allFiles.length} files measured, avg ${pctStr(avg)}; report: ${sources.join(', ') || 'unknown'}${pathFilter ? `; filter ${pathFilter}` : ''}).`,
        ``,
        `Modules by average coverage (worst first):`,
        ...rollup.slice(0, 20).map((m) => `  ${pctStr(m.avg).padStart(5)}  ${m.name}  (${m.measured}/${m.total} files measured)`),
        ``,
        `Refactor-risk hotspots — connected symbols with low coverage (ranked by degree × uncovered):`,
        ...(risky.length
            ? risky.map((s) => `  ${pctStr(s.coverage).padStart(5)}  deg ${String(s.degree).padStart(3)}  ${s.label}  (${s.file}${s.line ? `:${s.line}` : ''})`)
            : ['  (none — every connected symbol is ≥80% covered or unmeasured)']),
        ``,
        `Tip: before refactoring a hotspot, run get_dependents on it — low coverage × many dependents means write tests first.`,
    ].join('\n')
}

// HTTP endpoint inventory: Express/Fastify/Nest/Flask/FastAPI/Go-mux style route definitions.
function tListEndpoints(g, args, ctx) {
    if (!ctx.repoRoot) return 'Endpoint detection needs the repo root (not provided to this server).'
    const graph = rawGraph(ctx)
    const codeFiles = [...new Set(
        (graph.nodes || [])
            .filter((n) => !String(n.id).includes('#') && n.source_file && n.file_type === 'code')
            .map((n) => n.source_file)
    )]
    const eps = detectEndpoints(ctx.repoRoot, codeFiles)
    if (!eps.length) return 'No HTTP endpoints detected in the indexed code files.'
    const max = Math.max(1, Math.min(300, Number(args.max_results) || 100))
    const shown = eps.slice(0, max)
    return [
        `${eps.length} endpoint(s) detected${eps.length > shown.length ? `, showing ${shown.length}` : ''}:`,
        ...shown.map((e) => `  ${e.method.toUpperCase().padEnd(6)} ${e.path}${e.handler ? `  → ${e.handler}` : ''}  (${e.file}${e.line ? `:${e.line}` : ''})`),
    ].join('\n')
}

async function tRebuildGraph(g, args, ctx) {
    if (!ctx.repoRoot) return 'Rebuild needs the repo root (not provided to this server).'
    const mode = ['no-tests', 'tests-only', 'full'].includes(args.mode) ? args.mode : 'full'
    // snapshot the outgoing state: bytes → graph.prev.json (for graph_diff later), struct → inline delta
    let prevBytes = null
    try { prevBytes = readFileSync(ctx.graphPath) } catch { /* first build — nothing to diff against */ }
    const before = g?.nodes ? {nodes: g.nodes, links: g.links} : null
    const res = await buildGraphForRepo(ctx.repoRoot, {mode, scope: args.scope || ''})
    if (!res || !res.ok) return `Graph rebuild failed: ${(res && res.error) || 'unknown error'}`
    if (prevBytes) { try { writeFileSync(prevGraphPathFor(ctx.graphPath), prevBytes) } catch { /* snapshot is best-effort */ } }
    const fresh = ctx.reload() // refresh THIS server's in-memory graph so subsequent tool calls see the new graph
    const delta = before && fresh ? formatGraphDiff(diffGraphs(before, fresh)) : null
    return [
        `Rebuilt the graph (${mode}${args.scope ? `, scope=${args.scope}` : ''}). ${res.log || ''}. In-memory graph reloaded — graph tools now reflect it.`,
        delta
    ].filter(Boolean).join('\n\n')
}

// Retarget this server at ANOTHER local repository at runtime — one weavatrix registration serves any
// repo. Loads <parent>/weavatrix-graphs/<name>/graph.json (the central layout graphs
// always live in), building it first when missing. On a failed load the previous repo stays active.
async function tOpenRepo(g, args, ctx) {
    const repoPath = String(args.path || '').trim().replace(/[\\/]+$/, '')
    if (!repoPath) return 'Provide "path" — an absolute path to a local repository folder.'
    if (!existsSync(repoPath)) return `Path not found: ${repoPath}`
    const graphPath = join(graphOutDirForRepo(repoPath), 'graph.json')
    let built = false
    if (!existsSync(graphPath)) {
        if (args.build === false) return `No graph yet for ${repoPath} (expected at ${graphPath}). Re-call without build:false to build one — large repos can take minutes.`
        const mode = ['no-tests', 'tests-only', 'full'].includes(args.mode) ? args.mode : 'full'
        const res = await buildGraphForRepo(repoPath, {mode, scope: ''})
        if (!res || !res.ok) return `Graph build failed for ${repoPath}: ${(res && res.error) || 'unknown error'}`
        built = true
    }
    const prev = {graphPath: ctx.graphPath, repoRoot: ctx.repoRoot}
    ctx.graphPath = graphPath
    ctx.repoRoot = repoPath
    const loaded = ctx.reload()
    if (!loaded) {
        ctx.graphPath = prev.graphPath
        ctx.repoRoot = prev.repoRoot
        ctx.reload()
        return `Failed to load ${graphPath} — still targeting the previous repo (${prev.repoRoot || 'none'}).`
    }
    return `Opened ${repoPath}${built ? ' (graph built fresh)' : ''}: ${loaded.nodes.length} nodes / ${loaded.links.length} edges. All tools now target this repo.`
}

// ---- graph diff ----------------------------------------------------------------------------------
// One previous state is enough (4-13 MB per repo — cheap): rebuild_graph snapshots the outgoing
// graph.json as graph.prev.json and reports the structural delta inline, at the exact moment the fix
// is being verified. graph_diff re-queries the same pair later. Raw node/edge dumps would be noise —
// the signal is aggregated: module-dependency drift, cycle count changes, newly orphaned symbols.
const prevGraphPathFor = (graphPath) => String(graphPath).replace(/\.json$/, '.prev.json')
const edgeEndpoint = (v) => String(v && typeof v === 'object' ? v.id : v)
const fileOfId = (id) => { const s = String(id); const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h) }
const folderOfFile = (file) => {
    const dirs = String(file || '').split(/[\\/]/).filter(Boolean).slice(0, -1)
    return dirs.length ? dirs.slice(0, 2).join('/') : '(root)'
}

// Works on anything with {nodes, links}: the raw graph.json shape and the loadGraph struct alike.
function diffGraphs(oldG, newG) {
    const nodeIds = (graph) => new Set((graph.nodes || []).map((n) => String(n.id)))
    const oldNodes = nodeIds(oldG)
    const newNodes = nodeIds(newG)

    const edgeKey = (l) => `${edgeEndpoint(l.source)}|${l.relation || ''}|${edgeEndpoint(l.target)}`
    const edgeSet = (graph) => new Set((graph.links || []).map(edgeKey))
    const oldEdges = edgeSet(oldG)
    const newEdges = edgeSet(newG)

    const moduleEdges = (graph) => {
        const set = new Set()
        for (const l of graph.links || []) {
            if (l.relation === 'contains') continue
            const a = folderOfFile(fileOfId(edgeEndpoint(l.source)))
            const b = folderOfFile(fileOfId(edgeEndpoint(l.target)))
            if (a !== b) set.add(`${a} → ${b}`)
        }
        return set
    }
    const oldMods = moduleEdges(oldG)
    const newMods = moduleEdges(newG)

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

    const cycles = (graph) => { try { return findSccs(buildFileImportGraph(graph).adj).length } catch { return null } }

    return {
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
            removed: [...oldMods].filter((k) => !newMods.has(k))
        },
        // survived the rebuild but lost every caller/importer — likely made dead by the change
        orphaned: [...oldIn.keys()].filter((id) => newNodes.has(id) && !newIn.has(id)),
        cycles: {before: cycles(oldG), after: cycles(newG)}
    }
}

function formatGraphDiff(d) {
    if (!d.nodes.added.length && !d.nodes.removed.length && !d.edges.added && !d.edges.removed) {
        return 'No structural change between the two graph states.'
    }
    const cap = (list, n) => list.slice(0, n).map((x) => `  ${x}`).concat(list.length > n ? [`  … +${list.length - n} more`] : [])
    const lines = [`Structural delta: nodes +${d.nodes.added.length}/−${d.nodes.removed.length}, edges +${d.edges.added}/−${d.edges.removed}.`]
    if (d.cycles.before != null && d.cycles.after != null && d.cycles.before !== d.cycles.after) {
        lines.push(`Import cycles: ${d.cycles.before} → ${d.cycles.after}${d.cycles.after < d.cycles.before ? '  (cycle broken — fix confirmed)' : '  (NEW cycle introduced — see run_audit)'}`)
    }
    if (d.moduleEdges.added.length) lines.push('NEW module dependencies (architecture drift — review):', ...cap(d.moduleEdges.added, 12))
    if (d.moduleEdges.removed.length) lines.push('Removed module dependencies (decoupling confirmed):', ...cap(d.moduleEdges.removed, 12))
    if (d.orphaned.length) lines.push('Symbols that lost their last caller/importer (now dead?):', ...cap(d.orphaned, 10))
    if (d.nodes.added.length) lines.push('Added nodes:', ...cap(d.nodes.added, 12))
    if (d.nodes.removed.length) lines.push('Removed nodes:', ...cap(d.nodes.removed, 12))
    return lines.join('\n')
}

// Re-query the last rebuild's before/after pair (graph.prev.json vs graph.json), optionally scoped.
function tGraphDiff(g, args, ctx) {
    const prevPath = prevGraphPathFor(ctx.graphPath)
    let prev
    try { prev = JSON.parse(readFileSync(prevPath, 'utf8')) } catch {
        return `No previous graph state at ${prevPath} — rebuild_graph saves one automatically (a single prior state is kept).`
    }
    const current = rawGraph(ctx)
    const filter = args.path ? String(args.path).replace(/\\/g, '/') : null
    const scope = (graph) => filter ? {
        nodes: (graph.nodes || []).filter((n) => String(n.id).startsWith(filter)),
        links: (graph.links || []).filter((l) => String(edgeEndpoint(l.source)).startsWith(filter) || String(edgeEndpoint(l.target)).startsWith(filter))
    } : graph
    return [
        `Graph diff (previous rebuild state → current)${filter ? `, scoped to ${filter}` : ''}:`,
        formatGraphDiff(diffGraphs(scope(prev), scope(current)))
    ].join('\n')
}

// ---- change impact -------------------------------------------------------------------------------
function gitLines(repoRoot, args) {
    const res = spawnSync('git', ['-C', repoRoot, ...args], {encoding: 'utf8', timeout: 8000})
    if (res.status !== 0) return null
    return String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function resolveImpactBase(repoRoot, requested) {
    const candidates = requested ? [requested] : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']
    for (const ref of candidates) {
        const ok = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {encoding: 'utf8', timeout: 8000})
        if (ok.status === 0) return ref
    }
    return null
}

// Blast radius of a change, without any GitHub API: diff the CURRENT change (branch
// commits since the merge-base + staged/unstaged + untracked) against a base ref, map the changed
// files and their symbols onto the graph, and walk REVERSE dependency edges — everything the change
// can break, ranked by proximity + connectivity, with file-level test coverage attached so the
// untested part of the blast radius stands out. The pre-PR review, in one call.
function tChangeImpact(g, args, ctx) {
    if (!ctx.repoRoot) return 'change_impact needs the repo root (not provided to this server).'
    // Explicit file list (e.g. a PR's changed files from BranchPilot get_pull_request) skips the local
    // git diff entirely — this is how a NOT-checked-out PR gets its impact assessed (get_pr_impact parity).
    const explicit = Array.isArray(args.files)
        ? [...new Set(args.files.map((f) => String(f).replace(/\\/g, '/').trim()).filter(Boolean))]
        : null
    let changed
    let sourceLabel
    if (explicit) {
        if (!explicit.length) return 'files was provided but empty — pass repo-relative paths, or omit it to diff the local change.'
        changed = explicit
        sourceLabel = `for ${changed.length} provided file(s)`
    } else {
        const base = resolveImpactBase(ctx.repoRoot, args.base ? String(args.base).trim() : '')
        if (!base) return `Could not resolve a base ref${args.base ? ` ("${args.base}")` : ''} — pass base explicitly (e.g. origin/main or HEAD~1).`
        const committed = gitLines(ctx.repoRoot, ['diff', '--name-only', `${base}...HEAD`])
        if (committed === null) return `git diff against ${base} failed — is ${ctx.repoRoot} a git repository?`
        const uncommitted = gitLines(ctx.repoRoot, ['diff', '--name-only', 'HEAD']) || []
        const untracked = gitLines(ctx.repoRoot, ['ls-files', '--others', '--exclude-standard']) || []
        changed = [...new Set([...committed, ...uncommitted, ...untracked])]
        sourceLabel = `vs ${base}`
        if (!changed.length) return `No changes vs ${base} — working tree clean and no branch commits.`
    }

    const changedSet = new Set(changed)
    const seeds = new Set()
    const unmapped = []
    for (const file of changed) {
        if (!g.byId.has(file)) { unmapped.push(file); continue }
        seeds.add(file)
        for (const e of g.out.get(file) || []) if (e.relation === 'contains') seeds.add(String(e.id))
    }
    if (!seeds.size) {
        return [
            `${changed.length} changed file(s) ${sourceLabel}, but none are in the graph — new files or non-code.`,
            `Run rebuild_graph and retry for the full picture.`,
            `Changed: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}`,
        ].join('\n')
    }

    const maxDepth = Math.max(1, Math.min(4, Number(args.depth) || 2))
    const cap = Math.max(5, Math.min(120, Number(args.max_nodes) || 40))
    const depthOf = new Map([...seeds].map((s) => [s, 0]))
    const relOf = new Map()
    let frontier = [...seeds]
    for (let d = 0; d < maxDepth && frontier.length; d++) {
        const next = []
        for (const cur of frontier) {
            for (const e of g.inn.get(cur) || []) {
                if (e.relation === 'contains') continue
                const nid = String(e.id)
                if (depthOf.has(nid)) continue
                depthOf.set(nid, d + 1)
                relOf.set(nid, e.relation || 'rel')
                next.push(nid)
            }
        }
        frontier = next
    }
    const fileOfNode = (id) => { const s = String(id); const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h) }
    const impacted = [...depthOf.entries()]
        .filter(([nid]) => !seeds.has(nid) && !changedSet.has(fileOfNode(nid)))
        .map(([nid, d]) => ({id: nid, d, deg: degreeOf(g, nid), file: fileOfNode(nid)}))
        .sort((a, b) => a.d - b.d || b.deg - a.deg)

    // coverage overlay from EXISTING reports (fractions 0..1) — see coverage_map for details
    const knownFiles = (rawGraph(ctx).nodes || []).filter((n) => !String(n.id).includes('#') && n.source_file).map((n) => n.source_file)
    const coverage = readCoverageForRepo(ctx.repoRoot, knownFiles)
    const covOf = (file) => coverage.get(String(file).replace(/\\/g, '/'))?.pct ?? null
    const pctStr = (v) => (v == null ? 'cov n/a' : `cov ${Math.round(v * 100)}%`)

    const shown = impacted.slice(0, cap)
    const untestedHotspots = shown.filter((n) => { const c = covOf(n.file); return c != null && c < 0.5 && n.deg >= 5 })
    return [
        `Change impact ${sourceLabel}: ${changed.length} changed file(s) → ${seeds.size} graph seed(s) incl. their symbols${unmapped.length ? `; ${unmapped.length} file(s) not in the graph (new/non-code — rebuild_graph refreshes)` : ''}.`,
        impacted.length
            ? `${impacted.length} impacted node(s) within ${maxDepth} reverse hop(s), showing ${shown.length}:`
            : `Nothing else in the graph depends on the changed code within ${maxDepth} hop(s).`,
        ...shown.map((n) => `  [d${n.d}] ${relOf.get(n.id) || 'rel'}  ${labelOf(g, n.id)}  (deg ${n.deg}, ${pctStr(covOf(n.file))})  [${n.id}]`),
        untestedHotspots.length ? `` : null,
        untestedHotspots.length ? `Untested hotspots in the blast radius (<50% coverage, deg ≥5) — cover these before shipping:` : null,
        ...untestedHotspots.slice(0, 10).map((n) => `  ${labelOf(g, n.id)}  (${pctStr(covOf(n.file))}, deg ${n.deg})  ${n.file}`),
        ``,
        `Drill into any node with get_dependents / read_source; per-symbol coverage via coverage_map.`,
    ].filter((x) => x != null).join('\n')
}

// Sibling repos that already have a built graph in the central weavatrix-graphs folder — open_repo candidates.
function tListKnownRepos(g, args, ctx) {
    if (!ctx.repoRoot) return 'No repo root — cannot locate the central graphs folder.'
    const parent = dirname(ctx.repoRoot)
    const root = join(parent, 'weavatrix-graphs')
    const norm = (p) => String(p).replace(/[\\/]+/g, '/').toLowerCase()
    let entries = []
    try { entries = readdirSync(root, {withFileTypes: true}) } catch { return `No central graphs folder at ${root}.` }
    const rows = []
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const graphPath = join(root, entry.name, 'graph.json')
        try {
            const st = statSync(graphPath)
            rows.push({name: entry.name, repoPath: join(parent, entry.name), builtAt: st.mtime.toISOString()})
        } catch { /* no graph built for this entry */ }
    }
    if (!rows.length) return `No built graphs under ${root}.`
    return [
        `Repos with built graphs under ${root} (switch with open_repo):`,
        ...rows.map((r) => `  ${norm(r.repoPath) === norm(ctx.repoRoot) ? '»' : ' '} ${r.name} — graph built ${r.builtAt}  (${r.repoPath})`),
    ].join('\n')
}

// Each tool declares a capability GROUP; the server exposes only groups enabled for this repo (argv[4]).
const TOOLS = [
    {cap: 'graph', name: 'graph_stats', description: 'Return summary statistics: node count, edge count, communities, confidence breakdown, and graph build time vs repo HEAD (staleness).', inputSchema: {type: 'object', properties: {}}, run: (g, a, ctx) => tGraphStats(g, ctx)},
    {cap: 'graph', name: 'get_node', description: 'Get full details for a specific node by label or ID.', inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'Node label or ID to look up'}}, required: ['label']}, run: tGetNode},
    {cap: 'graph', name: 'get_neighbors', description: 'Get all direct neighbors of a node with edge details (1 hop, call sites deduped). For transitive impact use get_dependents; for the impact of your current branch changes use change_impact.', inputSchema: {type: 'object', properties: {label: {type: 'string'}, relation_filter: {type: 'string', description: 'Optional: filter by relation type'}}, required: ['label']}, run: tGetNeighbors},
    {cap: 'graph', name: 'query_graph', description: 'Explore the graph around a concept (BFS/DFS). Returns a focused, ranked subgraph — the closest, most-connected nodes near the matched seeds, with edges among them — not the full flood; states how many nodes were reached vs shown.', inputSchema: {type: 'object', properties: {question: {type: 'string', description: 'Natural language question or keyword search'}, mode: {type: 'string', enum: ['bfs', 'dfs'], default: 'bfs'}, depth: {type: 'integer', default: 3}, context_filter: {type: 'array', items: {type: 'string'}}, token_budget: {type: 'integer', description: 'Higher budget shows more nodes/edges', default: 2000}}, required: ['question']}, run: tQueryGraph},
    {cap: 'graph', name: 'god_nodes', description: 'Return the most connected nodes - the core abstractions of the knowledge graph.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', default: 10}}}, run: tGodNodes},
    {cap: 'graph', name: 'shortest_path', description: 'Find the shortest path between two concepts in the knowledge graph.', inputSchema: {type: 'object', properties: {source: {type: 'string'}, target: {type: 'string'}, max_hops: {type: 'integer', default: 8}}, required: ['source', 'target']}, run: tShortestPath},
    {cap: 'graph', name: 'get_dependents', description: 'Transitive blast-radius of ONE node: everything that calls/imports/inherits it, directly or through intermediaries (reverse edges, ranked by proximity then connectivity). For a symbol, also follows importers of its containing file. Use before refactoring; get_neighbors shows only 1 hop, change_impact covers your whole current diff at once.', inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'Node label or ID'}, depth: {type: 'integer', description: 'Max reverse hops, default 3', default: 3}, max_nodes: {type: 'integer', description: 'Max dependents to list, default 40', default: 40}}, required: ['label']}, run: (g, args) => tGetDependents(g, args)},
    {cap: 'graph', name: 'change_impact', description: 'Blast radius of a change: by default diffs branch commits + staged/unstaged/untracked work against a base ref (auto merge-base with origin/main|master), OR takes an explicit `files` list (e.g. a PR\'s changed files from BranchPilot get_pull_request — assesses a NOT-checked-out PR). Maps changed files/symbols onto the graph and lists everything depending on them (reverse edges, ranked by proximity + connectivity) with test coverage attached — untested hotspots called out. Run before opening or reviewing a PR; drill down with get_dependents, coverage detail via coverage_map.', inputSchema: {type: 'object', properties: {base: {type: 'string', description: 'Base ref, e.g. origin/main or HEAD~1 (default: first existing of origin/HEAD, origin/main, origin/master, main, master)'}, files: {type: 'array', items: {type: 'string'}, description: 'Explicit repo-relative changed-file list — skips the local git diff; use for PRs that are not checked out'}, depth: {type: 'integer', description: 'Max reverse hops, default 2'}, max_nodes: {type: 'integer', description: 'Max impacted nodes to list, default 40'}}}, run: (g, args, ctx) => tChangeImpact(g, args, ctx)},
    {cap: 'graph', name: 'get_community', description: 'Get all nodes in a community by community ID (0-indexed by size).', inputSchema: {type: 'object', properties: {community_id: {type: 'integer', description: 'Community ID (0-indexed by size)'}}, required: ['community_id']}, run: tGetCommunity},
    {cap: 'search', name: 'search_code', description: 'Full-text or regex search across the repo source (ripgrep-backed, Node fallback). The graph only stores structure — use this to find literal text/patterns, then get_node/get_neighbors for structure.', inputSchema: {type: 'object', properties: {query: {type: 'string', description: 'text or regex to search for'}, is_regex: {type: 'boolean', default: false}, glob: {type: 'string', description: 'optional path glob, e.g. "*.js" or "src/**"'}, max_results: {type: 'integer', default: 40}}, required: ['query']}, run: (g, args, ctx) => searchCode({repoRoot: ctx.repoRoot, resolveRg}, args)},
    {cap: 'source', name: 'read_source', description: "Read the actual source of a node (by label/ID) or a repo-relative file path — the symbol's lines with context. The graph stores only locations, not source text.", inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'node label or ID'}, path: {type: 'string', description: 'or a repo-relative file path'}, before: {type: 'integer', default: 3}, after: {type: 'integer', default: 40}}}, run: (g, args, ctx) => readSource({repoRoot: ctx.repoRoot, resolveNode, isSymbol}, g, args)},
    {cap: 'health', name: 'find_duplicates', description: 'Content-based clone detection over the repo (MOSS winnowing over method bodies — finds copy-paste even with renamed variables, not just matching names). Returns clone groups with file:line sites. Use to guide de-duplication refactors.', inputSchema: {type: 'object', properties: {min_similarity: {type: 'integer', description: '50-100, default 80'}, min_tokens: {type: 'integer', description: 'min fragment size, default 50'}, mode: {type: 'string', enum: ['renamed', 'strict'], default: 'renamed'}, include_tests: {type: 'boolean', default: false}, top_n: {type: 'integer', default: 15}}}, run: (g, args, ctx) => tFindDuplicates(g, args, ctx)},
    {cap: 'health', name: 'run_audit', description: 'Full internal health audit of the repo: dead code (unused files/exports), dependency health (missing/undeclared and unused npm/Go/Python deps), structure (import cycles, orphan files, boundary-rule violations), and offline supply-chain checks (known OSV vulnerabilities, typosquats, lockfile drift). Filter by category/severity. Malware heuristics are opt-in (slow).', inputSchema: {type: 'object', properties: {category: {type: 'string', enum: ['unused', 'structure', 'vulnerability', 'malware'], description: 'Only findings of this category'}, min_severity: {type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Minimum severity to include'}, max_findings: {type: 'integer', description: 'Max findings to list, default 30'}, include_malware_scan: {type: 'boolean', description: 'Also grep installed packages for malware heuristics (slow)', default: false}}}, run: (g, args, ctx) => tRunAudit(g, args, ctx)},
    {cap: 'health', name: 'coverage_map', description: 'Map an existing test-coverage report (istanbul/lcov/coverage.py/Go cover.out — read offline, never runs tests) onto the code graph: per-module coverage plus refactor-risk hotspots — well-connected symbols with low coverage, ranked by degree × uncovered. Pair with get_dependents: many dependents + low coverage ⇒ write tests before changing.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', description: 'Max risk hotspots to list, default 15'}, path: {type: 'string', description: 'Optional repo-relative path prefix filter, e.g. src/query'}}}, run: (g, args, ctx) => tCoverageMap(g, args, ctx)},
    {cap: 'graph', name: 'list_communities', description: 'List graph communities named by their dominant folder (largest first) with sample files — a readable module overview; feed the list position into get_community.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', description: 'Max communities to list, default 20'}}}, run: (g, args, ctx) => tListCommunities(g, args, ctx)},
    {cap: 'graph', name: 'module_map', description: 'Folder-level architecture map: modules with file/symbol counts plus the strongest module→module dependency edges. Fast orientation before diving into files.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', description: 'Max modules to list, default 25'}}}, run: (g, args, ctx) => tModuleMap(g, args, ctx)},
    {cap: 'source', name: 'list_endpoints', description: 'Inventory of HTTP endpoints defined in the repo (Express/Fastify/Nest/Flask/FastAPI/Go mux …): method, path, handler, and file:line, deduped across code and OpenAPI docs.', inputSchema: {type: 'object', properties: {max_results: {type: 'integer', description: 'Max endpoints to list, default 100'}}}, run: (g, args, ctx) => tListEndpoints(g, args, ctx)},
    {cap: 'build', name: 'rebuild_graph', description: "Rebuild this repo's code graph from current source (weavatrix's own web-tree-sitter builder), reload it in-memory, and report the STRUCTURAL DELTA vs the previous state — new/removed module dependencies, cycle changes, newly orphaned symbols. The prior state is saved as graph.prev.json for graph_diff. Call after significant edits.", inputSchema: {type: 'object', properties: {mode: {type: 'string', enum: ['full', 'no-tests', 'tests-only'], default: 'full'}, scope: {type: 'string', description: 'optional path prefix to limit the graph'}}}, run: (g, args, ctx) => tRebuildGraph(g, args, ctx)},
    {cap: 'graph', name: 'graph_diff', description: 'Structural diff of the last rebuild: previous graph state (graph.prev.json, saved by rebuild_graph) vs current — architecture drift (new module dependencies), broken or introduced import cycles, symbols that lost their last caller. The semantic complement to the textual git diff for validating a refactor.', inputSchema: {type: 'object', properties: {path: {type: 'string', description: 'Optional node-id/path prefix to scope the diff, e.g. src/query'}}}, run: (g, args, ctx) => tGraphDiff(g, args, ctx)},
    {cap: 'build', name: 'open_repo', description: 'Retarget this server at another local repository: loads its graph from the central weavatrix-graphs layout next to the repo, building it first when missing (large repos can take minutes; pass build:false to probe without building). Afterwards every tool answers for the new repo.', inputSchema: {type: 'object', properties: {path: {type: 'string', description: 'Absolute path to the repository folder'}, build: {type: 'boolean', description: 'Build the graph when missing (default true)', default: true}, mode: {type: 'string', enum: ['full', 'no-tests', 'tests-only'], default: 'full'}}, required: ['path']}, run: (g, args, ctx) => tOpenRepo(g, args, ctx)},
    {cap: 'graph', name: 'list_known_repos', description: 'List sibling repositories that already have a built graph in the central weavatrix-graphs folder next to the current repo — ready targets for open_repo.', inputSchema: {type: 'object', properties: {}}, run: (g, args, ctx) => tListKnownRepos(g, args, ctx)},
]
// argv[4] = comma-separated enabled capability groups (from the per-repo Settings config); absent/empty
// → ALL enabled (backward-compatible with older registrations).
// argv[4] ABSENT (undefined) = no per-repo config → ALL tools (backward-compat). argv[4] PRESENT
// (even the empty string, which the registration passes for a zero-capability selection) = an explicit
// set → expose exactly those groups, so "select nothing" really exposes nothing (an empty "" must NOT
// collapse back to "all").
const capsArg = process.argv[4]
const CAPS = capsArg == null ? null : new Set(String(capsArg).split(',').map((s) => s.trim()).filter(Boolean))
const ENABLED_TOOLS = CAPS ? TOOLS.filter((t) => CAPS.has(t.cap)) : TOOLS
const TOOL_BY_NAME = new Map(ENABLED_TOOLS.map((t) => [t.name, t]))

// Everything the stdio shell swaps in on hot reload. A fresh cache-busted import of this module
// re-evaluates all tool implementations (and their helpers) and exposes them here; the running shell
// replaces its tool table with this without restarting the process.
export const HOT_API = {tools: ENABLED_TOOLS, stalenessLine, resetStalenessCache}

// ---- JSON-RPC 2.0 over newline-delimited stdio (MCP stdio transport) -----------------------------
function main() {
    let graph = null
    let graphError = null
    // ctx owns the CURRENT target: rebuild_graph reloads it, open_repo retargets graphPath/repoRoot
    // at runtime. loadInto always reads ctx.graphPath so both paths share one loader.
    const ctx = {graphPath: process.argv[2], repoRoot: REPO_ROOT, reload: null}
    const loadInto = () => { graph = loadGraph(ctx.graphPath); graphError = null; return graph }
    ctx.reload = () => { api.resetStalenessCache(); try { return loadInto() } catch (e) { graphError = e.message; return null } }
    try {
        if (!ctx.graphPath) throw new Error('no graph.json path given (argv[2])')
        loadInto()
        log(`loaded ${graph.nodes.length} nodes / ${graph.links.length} edges from ${ctx.graphPath}`)
    } catch (e) {
        graphError = e.message
        log(`failed to load graph: ${e.message}`)
    }
    log(`repo root: ${REPO_ROOT || '(none — source/action tools disabled)'}`)
    log(`capabilities: ${CAPS ? [...CAPS].join(',') : 'all'} (${ENABLED_TOOLS.length} tools)`)

    let protocolVersion = DEFAULT_PROTOCOL
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
    const reply = (id, result) => send({jsonrpc: '2.0', id, result})
    const fail = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}})

    // ---- hot reload of tool implementations -------------------------------------------------------
    // Node caches this module at spawn, so edits to this file would otherwise be invisible until the
    // MCP client reconnects. Before each tools/list|call we stat this file; when it changed on disk we
    // re-import it with a cache-busting URL and swap in the fresh HOT_API (tool implementations +
    // staleness helpers), then notify the client that the tool list may have changed. The stdio shell,
    // graph loader, and in-memory graph state are NOT swapped — changing those still needs a reconnect.
    const SELF_PATH = fileURLToPath(import.meta.url)
    let api = {tools: ENABLED_TOOLS, byName: TOOL_BY_NAME, stalenessLine, resetStalenessCache}
    let loadedMtimeMs = 0
    let lastFailedMtimeMs = 0
    try { loadedMtimeMs = statSync(SELF_PATH).mtimeMs } catch { /* stat failure just disables reloads */ }
    const maybeHotReload = async () => {
        let mtimeMs
        try { mtimeMs = statSync(SELF_PATH).mtimeMs } catch { return }
        if (mtimeMs <= loadedMtimeMs || mtimeMs === lastFailedMtimeMs) return
        try {
            const fresh = await import(`${pathToFileURL(SELF_PATH).href}?v=${mtimeMs}`)
            if (!fresh.HOT_API?.tools) throw new Error('reloaded module exports no HOT_API')
            api = {
                tools: fresh.HOT_API.tools,
                byName: new Map(fresh.HOT_API.tools.map((t) => [t.name, t])),
                stalenessLine: fresh.HOT_API.stalenessLine,
                resetStalenessCache: fresh.HOT_API.resetStalenessCache,
            }
            loadedMtimeMs = mtimeMs
            log(`hot-reloaded tool implementations from changed source (${api.tools.length} tools)`)
            send({jsonrpc: '2.0', method: 'notifications/tools/list_changed'})
        } catch (e) {
            lastFailedMtimeMs = mtimeMs // remember the broken version so we don't retry it every call
            log(`hot-reload failed, keeping current tools: ${e.message}`)
        }
    }

    const handle = async (msg) => {
        const {id, method, params} = msg
        const isNotification = id === undefined || id === null
        if (method === 'initialize') {
            if (params?.protocolVersion) protocolVersion = String(params.protocolVersion)
            return reply(id, {protocolVersion, capabilities: {tools: {listChanged: true}}, serverInfo: SERVER_INFO})
        }
        if (method === 'notifications/initialized' || method === 'initialized') return
        if (method === 'ping') return reply(id, {})
        if (method === 'tools/list') {
            await maybeHotReload()
            return reply(id, {tools: api.tools.map(({name, description, inputSchema}) => ({name, description, inputSchema}))})
        }
        if (method === 'tools/call') {
            await maybeHotReload()
            const tool = api.byName.get(params?.name)
            if (!tool) return reply(id, {content: [{type: 'text', text: `Unknown tool: ${params?.name}`}], isError: true})
            // action tools (rebuild_graph) don't need a currently-loaded graph; read tools do
            if (!graph && tool.cap !== 'build') return reply(id, {content: [{type: 'text', text: `Graph unavailable: ${graphError}`}], isError: true})
            try {
                let text = String(await tool.run(graph, params?.arguments || {}, ctx))
                // Graph answers silently reflect a point-in-time build — surface staleness on every graph tool.
                if (tool.cap === 'graph') {
                    const warn = api.stalenessLine(ctx)
                    if (warn) text += `\n\n${warn}`
                }
                return reply(id, {content: [{type: 'text', text}]})
            } catch (e) {
                log(`tool ${params?.name} threw: ${e.stack || e.message}`)
                return reply(id, {content: [{type: 'text', text: `Tool error: ${e.message}`}], isError: true})
            }
        }
        if (!isNotification) return fail(id, -32601, `Method not found: ${method}`)
    }

    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) continue
            let msg
            try {
                msg = JSON.parse(line)
            } catch {
                log(`bad JSON line: ${line.slice(0, 120)}`)
                continue
            }
            // handle is async (rebuild_graph awaits a build) → catch rejections, not just sync throws
            Promise.resolve().then(() => handle(msg)).catch((e) => {
                log(`handler error: ${e.stack || e.message}`)
                if (msg?.id != null) fail(msg.id, -32603, `Internal error: ${e.message}`)
            })
        }
    })
    process.stdin.on('end', () => process.exit(0))
    log('ready')
}

// Hot-reload guard: cache-busted re-imports of this module must NOT start a second stdio loop —
// only the first import runs main(); fresh copies exist purely to supply their HOT_API exports.
if (!globalThis.__weavatrixMcpStarted) {
    globalThis.__weavatrixMcpStarted = true
    main()
}
