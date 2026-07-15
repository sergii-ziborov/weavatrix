// Structural graph delta helpers split from graph-context so the process-lifetime graph indexes stay small.
import {buildFileImportGraph, findSccs} from '../analysis/dep-rules.js'
import {folderModuleOf} from '../analysis/graph-analysis.aggregate.js'
import {isStructuralRelation} from '../graph/relations.js'

// ---- graph diff ----------------------------------------------------------------------------------
// One previous state is enough (4-13 MB per repo — cheap): rebuild_graph snapshots the outgoing
// graph.json as graph.prev.json and reports the structural delta inline, at the exact moment the fix
// is being verified. graph_diff re-queries the same pair later. Raw node/edge dumps would be noise —
// the signal is aggregated: module-dependency drift, cycle count changes, newly orphaned symbols.
export const prevGraphPathFor = (graphPath) => String(graphPath).replace(/\.json$/, '.prev.json')
export const edgeEndpoint = (v) => String(v && typeof v === 'object' ? v.id : v)
export const fileOfId = (id) => { const s = String(id); const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h) }
const folderOfFile = folderModuleOf

// Works on anything with {nodes, links}: the raw graph.json shape and the loadGraph struct alike.
export function diffGraphs(oldG, newG) {
    const oldEdgeTypesV = Number(oldG.edgeTypesV) || 0
    const newEdgeTypesV = Number(newG.edgeTypesV) || 0
    const schemaMigration = oldEdgeTypesV !== newEdgeTypesV
    const nodeIds = (graph) => new Set((graph.nodes || []).map((n) => String(n.id)))
    const oldNodes = nodeIds(oldG)
    const newNodes = nodeIds(newG)

    const edgeClass = (l) => l.typeOnly === true ? 'type' : l.compileOnly === true ? 'compile' : 'runtime'
    const edgeKey = (l) => `${edgeEndpoint(l.source)}|${l.relation || ''}|${schemaMigration ? 'untyped' : edgeClass(l)}|${edgeEndpoint(l.target)}`
    const edgeSet = (graph) => new Set((graph.links || []).map(edgeKey))
    const oldEdges = edgeSet(oldG)
    const newEdges = edgeSet(newG)

    const moduleEdges = (graph, classification) => {
        const set = new Set()
        for (const l of graph.links || []) {
            if (isStructuralRelation(l.relation)) continue
            if (edgeClass(l) !== classification) continue
            const a = folderOfFile(fileOfId(edgeEndpoint(l.source)))
            const b = folderOfFile(fileOfId(edgeEndpoint(l.target)))
            if (a !== b) set.add(`${a} → ${b}`)
        }
        return set
    }
    // A parser/schema upgrade can discover edges that the old graph could not represent (Rust use/mod in
    // edgeTypesV2). Do not call that architecture drift: establish a fresh classification baseline.
    const oldMods = schemaMigration ? new Set() : moduleEdges(oldG, 'runtime')
    const newMods = schemaMigration ? new Set() : moduleEdges(newG, 'runtime')
    const oldTypeMods = schemaMigration ? new Set() : moduleEdges(oldG, 'type')
    const newTypeMods = schemaMigration ? new Set() : moduleEdges(newG, 'type')
    const oldCompileMods = schemaMigration ? new Set() : moduleEdges(oldG, 'compile')
    const newCompileMods = schemaMigration ? new Set() : moduleEdges(newG, 'compile')

    const incoming = (graph) => {
        const m = new Map()
        for (const l of graph.links || []) {
            if (isStructuralRelation(l.relation)) continue
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
            compileAdded: [...newCompileMods].filter((k) => !oldCompileMods.has(k)),
            compileRemoved: [...oldCompileMods].filter((k) => !newCompileMods.has(k)),
        },
        // survived the rebuild but lost every caller/importer — likely made dead by the change
        orphaned: [...oldIn.keys()].filter((id) => newNodes.has(id) && !newIn.has(id)),
        cycles: {
            runtime: schemaMigration ? null : cycleDelta(cycles(oldG, false), cycles(newG, false)),
            // Backward-compatible field name: since edgeTypesV 2 this includes typeOnly and compileOnly.
            typeInclusive: schemaMigration ? null : cycleDelta(cycles(oldG, true), cycles(newG, true)),
        }
    }
}

export function formatGraphDiff(d) {
    if (!d.nodes.added.length && !d.nodes.removed.length && !d.edges.added && !d.edges.removed) {
        return d.schemaMigration
            ? `Graph edge schema upgraded v${d.schemaMigration.from} → v${d.schemaMigration.to}; compile-time baseline established. Runtime/compile-time cycle and module classifications are intentionally not compared on this rebuild.`
            : 'No structural change between the two graph states.'
    }
    const cap = (list, n) => list.slice(0, n).map((x) => `  ${x}`).concat(list.length > n ? [`  … +${list.length - n} more`] : [])
    const lines = [`Structural delta: nodes +${d.nodes.added.length}/−${d.nodes.removed.length}, edges +${d.edges.added}/−${d.edges.removed}.`]
    if (d.schemaMigration) lines.push(`Graph edge schema upgraded v${d.schemaMigration.from} → v${d.schemaMigration.to}; runtime/compile-time cycle and module classifications are intentionally not compared until the next rebuild.`)
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
        lines.push(`Compile-time-inclusive dependency SCCs: count ${all.before} → ${all.after}, largest ${all.largestBefore} → ${all.largestAfter} (compile-time coupling, not necessarily a runtime cycle).`)
    }
    if (d.moduleEdges.added.length) lines.push('NEW module dependencies (architecture drift — review):', ...cap(d.moduleEdges.added, 12))
    if (d.moduleEdges.removed.length) lines.push('Removed module dependencies (decoupling confirmed):', ...cap(d.moduleEdges.removed, 12))
    if (d.moduleEdges.typeAdded.length) lines.push('New type-only module dependencies (compile-time coupling):', ...cap(d.moduleEdges.typeAdded, 12))
    if (d.moduleEdges.typeRemoved.length) lines.push('Removed type-only module dependencies:', ...cap(d.moduleEdges.typeRemoved, 12))
    if (d.moduleEdges.compileAdded.length) lines.push('New compile-only module dependencies (compile-time coupling):', ...cap(d.moduleEdges.compileAdded, 12))
    if (d.moduleEdges.compileRemoved.length) lines.push('Removed compile-only module dependencies:', ...cap(d.moduleEdges.compileRemoved, 12))
    if (d.orphaned.length) lines.push('Symbols that lost their last caller/importer (now dead?):', ...cap(d.orphaned, 10))
    if (d.nodes.added.length) lines.push('Added nodes:', ...cap(d.nodes.added, 12))
    if (d.nodes.removed.length) lines.push('Removed nodes:', ...cap(d.nodes.removed, 12))
    return lines.join('\n')
}
