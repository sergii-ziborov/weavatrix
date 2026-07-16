// Graph query tools: stats, node lookup, neighbors, hubs, communities, exploratory traversal and
// shortest path. Pure reads over the loaded graph — no filesystem or process access beyond the
// staleness probe in graph-context. Hot-reloadable (re-imported by catalog.mjs on change).
import {
    isSymbol, degreeOf, labelOf, connList,
    resolveNodeInfo, resolveNode, ambiguityNote, findSeeds, resolveSeedFiles, undirectedNeighbors,
    graphStaleness, fileStalenessNote,
} from './graph-context.mjs'

const compileKind = (edge) => edge?.typeOnly === true ? 'type-only' : edge?.compileOnly === true ? 'compile-only' : null

export function tGraphStats(g, ctx) {
    const files = g.nodes.filter((n) => !isSymbol(n.id)).length
    const symbols = g.nodes.length - files
    const relCount = {}
    const confCount = {}
    let typeOnlyEdges = 0
    let compileOnlyEdges = 0
    for (const e of g.links) {
        relCount[e.relation ?? '?'] = (relCount[e.relation ?? '?'] || 0) + 1
        if (e.confidence != null) confCount[e.confidence] = (confCount[e.confidence] || 0) + 1
        if (e.typeOnly === true) typeOnlyEdges++
        if (e.compileOnly === true) compileOnlyEdges++
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
        g.edgeTypesV ? `- Typed-edge metadata: v${g.edgeTypesV} (${typeOnlyEdges} type-only, ${compileOnlyEdges} compile-only edges)` : `- Typed-edge metadata: unavailable (rebuild_graph required)`,
        g.barrelResolutionV ? `- Barrel resolution: v${g.barrelResolutionV} (semantic tools look through JS/TS re-export facades)` : `- Barrel resolution: unavailable (rebuild_graph required for JS/TS barrel transparency)`,
        `- Relations: ${fmt(relCount)}`,
        Object.keys(confCount).length ? `- Confidence: ${fmt(confCount)}` : null,
        `- Communities: ${comm.size} (top by size: ${topComm.map(([c, n]) => `#${c}=${n}`).join(', ')})`,
        freshness?.builtAt ? `- Built: ${freshness.builtAt.toISOString()}${freshness.headAt ? ` (repo HEAD committed ${freshness.headAt.toISOString()})` : ''}` : null,
    ]
        .filter(Boolean)
        .join('\n')
}

export function tGetNode(g, {label} = {}, ctx) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const id = String(n.id)
    const drift = ctx ? fileStalenessNote(ctx, n.source_file || (isSymbol(id) ? id.split('#')[0] : id)) : null
    const outs = g.out.get(id) || []
    const ins = g.inn.get(id) || []
    const semanticOuts = connList(outs)
    const semanticIns = connList(ins)
    const sample = (list, dir) =>
        list
            .slice(0, 12)
            .map((e) => `  ${dir === 'out' ? '→' : '←'} ${compileKind(e) ? `${compileKind(e)} ` : ''}${e.relation || 'rel'}  ${labelOf(g, e.id)}  [${e.id}]`)
            .join('\n') || '  (none)'
    return [
        note,
        `Node: ${n.label ?? id}`,
        `- id: ${id}`,
        `- kind: ${isSymbol(id) ? 'symbol' : 'file'}${n.file_type ? ` (${n.file_type})` : ''}`,
        n.source_file ? `- source: ${n.source_file}${n.source_location ? ` ${n.source_location}` : ''}` : null,
        n.community != null ? `- community: ${n.community}` : null,
        `- semantic degree: ${semanticOuts.length + semanticIns.length} (out ${semanticOuts.length}, in ${semanticIns.length})${outs.length + ins.length !== semanticOuts.length + semanticIns.length ? `; ${outs.length + ins.length} physical/structural edges retained` : ''}`,
        `Outgoing:\n${sample(outs, 'out')}`,
        `Incoming:\n${sample(ins, 'in')}`,
        drift,
    ]
        .filter(Boolean)
        .join('\n')
}

// Collapse repeated edges to the same neighbor (one per call site in the graph) into `(N sites)` —
// a hub function's caller list shrinks ~2-3x with no information loss.
function dedupeEdges(list) {
    const grouped = new Map()
    for (const e of list) {
        const key = `${e.relation || 'rel'}|${compileKind(e) || 'runtime'}|${e.id}`
        const cur = grouped.get(key)
        if (cur) cur.count += 1
        else grouped.set(key, {id: e.id, relation: e.relation, typeOnly: e.typeOnly === true, compileOnly: e.compileOnly === true, count: 1})
    }
    return [...grouped.values()]
}

export function tGetNeighbors(g, {label, relation_filter} = {}, ctx) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const id = String(n.id)
    const drift = ctx ? fileStalenessNote(ctx, n.source_file || (isSymbol(id) ? id.split('#')[0] : id)) : null
    const rf = relation_filter ? String(relation_filter).toLowerCase() : null
    const match = (e) => !rf || String(e.relation ?? '').toLowerCase() === rf
    const outsRaw = (g.out.get(id) || []).filter(match)
    const insRaw = (g.inn.get(id) || []).filter(match)
    const outs = dedupeEdges(outsRaw)
    const ins = dedupeEdges(insRaw)
    const line = (e, dir) =>
        `  ${dir === 'out' ? '→' : '←'} ${compileKind(e) ? `${compileKind(e)} ` : ''}${e.relation || 'rel'}  ${labelOf(g, e.id)}  [${e.id}]${e.count > 1 ? `  (${e.count} sites)` : ''}`
    return [
        note,
        `Neighbors of ${n.label ?? id}${rf ? ` (relation=${rf})` : ''}: ${outs.length + ins.length} unique (${outsRaw.length + insRaw.length} edges)`,
        `Outgoing (${outs.length}):`,
        ...outs.slice(0, 60).map((e) => line(e, 'out')),
        `Incoming (${ins.length}):`,
        ...ins.slice(0, 60).map((e) => line(e, 'in')),
        drift,
    ].filter(Boolean).join('\n')
}

export {tGodNodes} from './tools-graph-hubs.mjs'


export function tGetCommunity(g, {community_id} = {}) {
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

// A plain BFS/DFS flood dumps every reached node (thousands on a real graph) at near-zero signal.
// Instead: traverse to record reach + distance-from-seed, then show only the closest, most-connected
// slice as a coherent subgraph (edges kept only among shown nodes). Honest about what was trimmed.
export function tQueryGraph(g, {question, mode = 'bfs', depth = 3, context_filter, seed_files, augment_seeds = false, token_budget = 2000} = {}) {
    const pinned = resolveSeedFiles(g, seed_files)
    // Exact seed files are a control surface, not a hint: by default they disable fuzzy keyword seeds.
    // Callers can opt back into augmentation when they explicitly want both behaviors.
    const automatic = pinned.seeds.length && augment_seeds !== true
        ? []
        : findSeeds(g, question, Math.max(0, 8 - pinned.seeds.length))
    const seeds = [...pinned.seeds, ...automatic.filter((node) => !pinned.seeds.some((seed) => String(seed.id) === String(node.id)))]
    if (!seeds.length) return `No nodes matched "${question}".`
    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3))
    const ctx = Array.isArray(context_filter) && context_filter.length ? new Set(context_filter.map((c) => String(c).toLowerCase())) : null
    const relOk = (rel) => !ctx || ctx.has(String(rel ?? '').toLowerCase())
    const charBudget = Math.max(400, (Number(token_budget) || 2000) * 4)
    // node budget scales gently with the token budget; edges follow the surviving nodes.
    const nodeBudget = Math.max(20, Math.min(120, Math.round((Number(token_budget) || 2000) / 40)))
    const depthOf = new Map() // id -> shortest distance from any seed
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
    for (const source of shownIds) {
        for (const edge of g.out.get(source) || []) {
            const target = String(edge.id)
            if (edge.barrelProxy === true || !shownIds.has(target) || !relOk(edge.relation)) continue
            const key = `${source}|${edge.relation}|${target}`
            if (edgeSeen.has(key)) continue
            edgeSeen.add(key)
            shownEdges.push([source, edge.relation, target])
            if (shownEdges.length >= 160) break
        }
        if (shownEdges.length >= 160) break
    }
    const head = [
        `Query: "${question}" (${mode}, depth ${maxDepth}${ctx ? `, context ${[...ctx].join('/')}` : ''})`,
        `Seeds: ${seeds.map((s) => s.label ?? s.id).join(', ')}`,
        pinned.missing.length ? `Unresolved pinned seed files: ${pinned.missing.join(', ')}` : null,
        `Reached ${depthOf.size} nodes; showing ${shown.length} closest by proximity + connectivity, ${shownEdges.length} edges among them.`,
        ``,
        `Nodes:`,
    ]
    const nodeLines = shown.map((n) => `  [d${n.d}] ${labelOf(g, n.id)}  (deg ${n.deg})  [${n.id}]`)
    const edgeLines = ['', 'Edges:', ...shownEdges.map(([s, r, t]) => `  ${labelOf(g, s)} --${r || 'rel'}--> ${labelOf(g, t)}`)]
    let text = [...head.filter(Boolean), ...nodeLines, ...edgeLines].join('\n')
    if (text.length > charBudget) text = text.slice(0, charBudget) + `\n... (truncated to ~${token_budget} tokens)`
    return text
}

export function tShortestPath(g, {source, target, max_hops = 8} = {}) {
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
