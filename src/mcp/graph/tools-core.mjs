import {
    isSymbol, degreeOf, labelOf, connList, resolveNodeInfo, ambiguityNote,
    graphStaleness, fileStalenessNote,
} from '../graph-context.mjs'
import {summarizeEdgeProvenance} from '../../graph/edge-provenance.js'

const compileKind = (edge) => edge?.typeOnly === true ? 'type-only' : edge?.compileOnly === true ? 'compile-only' : null

export function tGraphStats(g, ctx) {
    const files = g.nodes.filter((node) => !isSymbol(node.id)).length
    const symbols = g.nodes.length - files
    const relCount = {}
    const confCount = {}
    let typeOnlyEdges = 0
    let compileOnlyEdges = 0
    for (const edge of g.links) {
        relCount[edge.relation ?? '?'] = (relCount[edge.relation ?? '?'] || 0) + 1
        if (edge.confidence != null) confCount[edge.confidence] = (confCount[edge.confidence] || 0) + 1
        if (edge.typeOnly === true) typeOnlyEdges++
        if (edge.compileOnly === true) compileOnlyEdges++
    }
    const communities = new Map()
    for (const node of g.nodes) {
        const community = node.community ?? 'none'
        communities.set(community, (communities.get(community) || 0) + 1)
    }
    const topCommunities = [...communities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    const formatCounts = (counts) => Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')
    const freshness = ctx ? graphStaleness(ctx) : null
    const provenance = summarizeEdgeProvenance(g.links)
    const precision = g.precision || {state: 'UNAVAILABLE', verifiedEdges: 0, candidates: 0, queried: 0, reason: 'no revision-matched precision overlay'}
    return [
        'Graph summary',
        ctx?.runtime ? `- Weavatrix runtime: v${ctx.runtime.version}; disk v${ctx.runtime.diskVersion || 'unavailable'}; stale ${ctx.runtime.staleRuntime ? 'YES' : 'no'}; profile ${ctx.runtime.profile}; ${ctx.runtime.toolCount} registered tools; capabilities: ${ctx.runtime.capabilities.join(',') || '(none)'}` : null,
        ctx?.repoRoot ? `- Repo: ${ctx.repoRoot}` : null,
        ctx?.graphPath ? `- Graph: ${ctx.graphPath}` : null,
        `- Build mode: ${g.graphBuildMode || 'full'}`,
        `- Nodes: ${g.nodes.length} (${files} files, ${symbols} symbols)`,
        `- Edges: ${g.links.length}`,
        g.edgeTypesV ? `- Typed-edge metadata: v${g.edgeTypesV} (${typeOnlyEdges} type-only, ${compileOnlyEdges} compile-only edges)` : '- Typed-edge metadata: unavailable (rebuild_graph required)',
        g.edgeProvenanceV ? `- Edge provenance: v${g.edgeProvenanceV} (${formatCounts(provenance.counts)}; ${provenance.complete ? 'complete' : `${provenance.counts.UNKNOWN} unclassified`})` : '- Edge provenance: unavailable (rebuild_graph required)',
        `- Semantic precision: ${precision.state}${precision.provider ? ` via ${precision.provider}${precision.providerVersion ? ` ${precision.providerVersion}` : ''}${precision.typescriptVersion ? ` (TypeScript ${precision.typescriptVersion})` : ''}` : ''}; ${precision.verifiedEdges || 0} EXACT_LSP edge(s), ${precision.queried || 0}/${precision.candidates || 0} bounded target(s) queried${precision.truncated ? ' (partial/truncated)' : ''}${precision.reason ? `; ${precision.reason}` : ''}`,
        g.barrelResolutionV ? `- Barrel resolution: v${g.barrelResolutionV} (semantic tools look through JS/TS re-export facades)` : '- Barrel resolution: unavailable (rebuild_graph required for JS/TS barrel transparency)',
        g.reExportOccurrencesV ? `- Re-export occurrences: v${g.reExportOccurrencesV} (${g.reExportOccurrences.length} exact site(s))` : '- Re-export occurrences: unavailable (rebuild_graph required)',
        g.symbolSpacesV ? `- TypeScript symbol spaces: v${g.symbolSpacesV} (type/value identities separated)` : '- TypeScript symbol spaces: unavailable (rebuild_graph required)',
        `- Relations: ${formatCounts(relCount)}`,
        Object.keys(confCount).length ? `- Legacy confidence: ${formatCounts(confCount)}` : null,
        `- Communities: ${communities.size} (top by size: ${topCommunities.map(([community, count]) => `#${community}=${count}`).join(', ')})`,
        freshness?.builtAt ? `- Built: ${freshness.builtAt.toISOString()}${freshness.headAt ? ` (repo HEAD committed ${freshness.headAt.toISOString()})` : ''}` : null,
    ].filter(Boolean).join('\n')
}

export function tGetNode(g, {label} = {}, ctx) {
    const info = resolveNodeInfo(g, label)
    const node = info.node
    if (!node) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const id = String(node.id)
    const drift = ctx ? fileStalenessNote(ctx, node.source_file || (isSymbol(id) ? id.split('#')[0] : id)) : null
    const outgoing = g.out.get(id) || []
    const incoming = g.inn.get(id) || []
    const semanticOutgoing = connList(outgoing)
    const semanticIncoming = connList(incoming)
    const sample = (edges, direction) => edges.slice(0, 12)
        .map((edge) => `  ${direction === 'out' ? '→' : '←'} ${compileKind(edge) ? `${compileKind(edge)} ` : ''}${edge.relation || 'rel'} [${edge.provenance || 'UNKNOWN'}]  ${labelOf(g, edge.id)}  [${edge.id}]`)
        .join('\n') || '  (none)'
    return [
        note,
        `Node: ${node.label ?? id}`,
        `- id: ${id}`,
        `- kind: ${isSymbol(id) ? 'symbol' : 'file'}${node.file_type ? ` (${node.file_type})` : ''}`,
        node.source_file ? `- source: ${node.source_file}${node.source_location ? ` ${node.source_location}` : ''}` : null,
        node.community != null ? `- community: ${node.community}` : null,
        `- semantic degree: ${semanticOutgoing.length + semanticIncoming.length} (out ${semanticOutgoing.length}, in ${semanticIncoming.length})${outgoing.length + incoming.length !== semanticOutgoing.length + semanticIncoming.length ? `; ${outgoing.length + incoming.length} physical/structural edges retained` : ''}`,
        `Outgoing:\n${sample(outgoing, 'out')}`,
        `Incoming:\n${sample(incoming, 'in')}`,
        drift,
    ].filter(Boolean).join('\n')
}

function dedupeEdges(edges) {
    const grouped = new Map()
    for (const edge of edges) {
        const key = `${edge.relation || 'rel'}|${compileKind(edge) || 'runtime'}|${edge.id}`
        const current = grouped.get(key)
        if (current) {
            current.count += 1
            current.provenance.add(edge.provenance || 'UNKNOWN')
        } else grouped.set(key, {
            id: edge.id, relation: edge.relation, typeOnly: edge.typeOnly === true,
            compileOnly: edge.compileOnly === true, provenance: new Set([edge.provenance || 'UNKNOWN']), count: 1,
        })
    }
    return [...grouped.values()]
}

export function tGetNeighbors(g, {label, relation_filter} = {}, ctx) {
    const info = resolveNodeInfo(g, label)
    const node = info.node
    if (!node) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const id = String(node.id)
    const drift = ctx ? fileStalenessNote(ctx, node.source_file || (isSymbol(id) ? id.split('#')[0] : id)) : null
    const filter = relation_filter ? String(relation_filter).toLowerCase() : null
    const matches = (edge) => !filter || String(edge.relation ?? '').toLowerCase() === filter
    const outgoingRaw = (g.out.get(id) || []).filter(matches)
    const incomingRaw = (g.inn.get(id) || []).filter(matches)
    const outgoing = dedupeEdges(outgoingRaw)
    const incoming = dedupeEdges(incomingRaw)
    const line = (edge, direction) => `  ${direction === 'out' ? '→' : '←'} ${compileKind(edge) ? `${compileKind(edge)} ` : ''}${edge.relation || 'rel'} [${[...edge.provenance].sort().join('+')}]  ${labelOf(g, edge.id)}  [${edge.id}]${edge.count > 1 ? `  (${edge.count} sites)` : ''}`
    return [
        note,
        `Neighbors of ${node.label ?? id}${filter ? ` (relation=${filter})` : ''}: ${outgoing.length + incoming.length} unique (${outgoingRaw.length + incomingRaw.length} edges)`,
        `Outgoing (${outgoing.length}):`,
        ...outgoing.slice(0, 60).map((edge) => line(edge, 'out')),
        `Incoming (${incoming.length}):`,
        ...incoming.slice(0, 60).map((edge) => line(edge, 'in')),
        drift,
    ].filter(Boolean).join('\n')
}

export function tGetCommunity(g, {community_id} = {}) {
    const groups = new Map()
    for (const node of g.nodes) {
        if (node.community == null) continue
        if (!groups.has(node.community)) groups.set(node.community, [])
        groups.get(node.community).push(node)
    }
    const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
    const index = Number(community_id)
    if (!Number.isInteger(index) || index < 0 || index >= ranked.length) return `Invalid community_id ${community_id}. Valid range 0..${ranked.length - 1} (0 = largest).`
    const [rawId, members] = ranked[index]
    const files = members.filter((member) => !isSymbol(member.id))
    return [
        `Community #${index} (raw id ${rawId}) — ${members.length} nodes, ${files.length} files:`,
        ...members.slice().sort((a, b) => degreeOf(g, b.id) - degreeOf(g, a.id)).slice(0, 80)
            .map((member) => `  ${member.label ?? member.id}  [${member.id}]`),
        members.length > 80 ? `  … +${members.length - 80} more` : null,
    ].filter(Boolean).join('\n')
}
