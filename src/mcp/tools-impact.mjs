// Impact tools: transitive blast radius of one node (get_dependents), the structural diff of the
// last rebuild (graph_diff), and the blast radius of the current change set (change_impact).
// Hot-reloadable (re-imported by catalog.mjs on change).
import {readFileSync} from 'node:fs'
import {
    isSymbol, degreeOf, labelOf, resolveNodeInfo, ambiguityNote,
    rawGraph, prevGraphPathFor, edgeEndpoint, diffGraphs, formatGraphDiff,
} from './graph-context.mjs'
import {querySymbolPrecision} from '../precision/symbol-query.js'
import {graphWithExactDirectReferences, refineChangeImpact} from './tools-impact-precision.mjs'
import {reverseReach} from './graph/reverse-reach.mjs'
import {tChangeImpactV2} from './tools-impact-change.mjs'
import {buildGraphAtGitRef} from '../analysis/git-ref-graph.js'

const impactKind = (entry) => {
    if (entry?.runtimeDepth != null) {
        return entry.compileDepth != null ? `runtime + compile-time(d${entry.compileDepth})` : 'runtime'
    }
    return 'compile-time'
}

// Transitive blast-radius: who is affected if this node changes. Walks REVERSE dependency edges
// (calls/imports/inherits — not structural `contains`) out to `depth`. For a symbol, also seeds its
// containing file, because importers depend on the file rather than the individual symbol.
function getDependentsFromGraph(g, {label, depth = 3, max_nodes = 40, include_container_importers = false} = {}, precisionNote = null) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3))
    const cap = Math.max(5, Math.min(120, Number(max_nodes) || 40))
    const id = String(n.id)
    const seeds = new Set([id])
    let containingFile = null
    if (include_container_importers === true && isSymbol(id)) {
        const container = (g.inn.get(id) || []).find((e) => e.relation === 'contains')
        if (container) {
            containingFile = String(container.id)
            seeds.add(containingFile)
        }
    }
    const reached = reverseReach(g, seeds, maxDepth)
    const ranked = [...reached.entries()]
        .filter(([nid]) => !seeds.has(nid))
        .map(([nid, entry]) => ({id: nid, d: entry.depth, entry, deg: degreeOf(g, nid)}))
        .sort((a, b) => a.d - b.d || Number(a.entry.compileOnly) - Number(b.entry.compileOnly) || b.deg - a.deg)
    if (!ranked.length) return [note, precisionNote, `No dependents found for ${n.label ?? id} within depth ${maxDepth} — nothing in the graph calls, imports, or inherits it.`].filter(Boolean).join('\n')
    const shown = ranked.slice(0, cap)
    const runtimeCount = ranked.filter((entry) => !entry.entry.compileOnly).length
    const compileCount = ranked.length - runtimeCount
    return [
        note,
        precisionNote,
        `Dependents of ${n.label ?? id} (reverse calls/imports/inherits, depth ≤${maxDepth}): ${ranked.length} found (${runtimeCount} runtime, ${compileCount} compile-time-only), showing ${shown.length} by proximity + connectivity.`,
        containingFile ? `Includes importers of its containing file ${labelOf(g, containingFile)} by explicit request.` : null,
        ...shown.map((r) => `  [d${r.d} ${impactKind(r.entry)}] ${r.entry.relation || 'rel'} [${r.entry.provenance || 'UNKNOWN'}]  ${labelOf(g, r.id)}  (deg ${r.deg})  [${r.id}]`),
    ].filter(Boolean).join('\n')
}

export function tGetDependents(g, args = {}, ctx = {}) {
    const info = resolveNodeInfo(g, args.label)
    const id = String(info.node?.id || '')
    const requested = ['auto', 'graph', 'lsp'].includes(args.precision) ? args.precision : 'auto'
    const canQuery = isSymbol(id) && ctx.repoRoot && ctx.graphPath
        && (requested === 'lsp' || (requested === 'auto' && g.graphPrecisionMode !== 'off'))
    if (!canQuery) {
        const note = isSymbol(id) && requested !== 'graph'
            ? 'Semantic precision: graph-only; an exact point query was unavailable or disabled.' : null
        return getDependentsFromGraph(g, args, note)
    }
    return (async () => {
        try {
            const result = await querySymbolPrecision({
                repoRoot: ctx.repoRoot,
                graphPath: ctx.graphPath,
                targetId: id,
                maxReferences: Math.max(100, Math.min(5_000, Number(args.max_references) || 1_000)),
                timeoutMs: Math.max(1_000, Math.min(60_000, Number(args.timeout_ms) || 30_000)),
                clientFactory: ctx.precisionClientFactory,
            })
            const exactGraph = graphWithExactDirectReferences(g, id, result.overlay)
            if (exactGraph) {
                const count = (result.overlay.links || []).filter((link) => String(link?.target || '') === id).length
                return getDependentsFromGraph(
                    exactGraph,
                    args,
                    `Semantic precision: EXACT_LSP point query${result.cached ? ' (cache hit)' : ''}; ${count} classified direct reference edge(s).`,
                )
            }
            return getDependentsFromGraph(
                g,
                args,
                `Semantic precision: ${result.overlay?.state || 'UNAVAILABLE'}; exact absence was not proven, so graph edges are retained (${result.overlay?.reason || 'incomplete project coverage'}).`,
            )
        } catch (error) {
            return getDependentsFromGraph(
                g,
                args,
                `Semantic precision: UNAVAILABLE; graph evidence retained (${error?.message || 'point query failed'}).`,
            )
        }
    })()
}

// Re-query the last rebuild's before/after pair (graph.prev.json vs graph.json), optionally scoped.
export async function tGraphDiff(g, args, ctx) {
    const current = rawGraph(ctx)
    const currentMode = ['full', 'no-tests', 'tests-only'].includes(current?.graphBuildMode)
        ? current.graphBuildMode
        : 'full'
    let prev
    let baselineLabel = 'previous rebuild state'
    if (args.base_ref) {
        if (!ctx.repoRoot) return 'A Git-ref graph diff needs the active repository root.'
        const built = await buildGraphAtGitRef(ctx.repoRoot, args.base_ref, {mode: currentMode})
        if (!built.ok) return `Could not build the baseline graph: ${built.error}`
        prev = built.graph
        baselineLabel = `${built.ref} (${built.commit.slice(0, 12)})`
    } else {
        const prevPath = prevGraphPathFor(ctx.graphPath)
        try { prev = JSON.parse(readFileSync(prevPath, 'utf8')) } catch {
            return `No previous graph state at ${prevPath} — pass base_ref (for example HEAD~1 or main), or run rebuild_graph to save one automatically.`
        }
    }
    if (!args.base_ref) {
        const previousMode = ['full', 'no-tests', 'tests-only'].includes(prev?.graphBuildMode)
            ? prev.graphBuildMode
            : 'full'
        if (previousMode !== currentMode) {
            return [
                `Graph diff unavailable: previous graph mode is ${previousMode}, current graph mode is ${currentMode}.`,
                'Those node/edge universes are not comparable. Run rebuild_graph once more in the same mode, or pass base_ref to build a mode-matched immutable baseline.',
            ].join('\n')
        }
    }
    const filter = args.path ? String(args.path).replace(/\\/g, '/') : null
    const scope = (graph) => filter ? {
        nodes: (graph.nodes || []).filter((n) => String(n.id).startsWith(filter)),
        links: (graph.links || []).filter((l) => String(edgeEndpoint(l.source)).startsWith(filter) || String(edgeEndpoint(l.target)).startsWith(filter)),
        edgeTypesV: graph.edgeTypesV || 0,
        edgeProvenanceV: graph.edgeProvenanceV || 0,
        barrelResolutionV: graph.barrelResolutionV || 0,
        extractorSchemaV: graph.extractorSchemaV || 0,
    } : graph
    return [
        `Graph diff (${baselineLabel} → current)${filter ? `, scoped to ${filter}` : ''}:`,
        `Build mode: ${currentMode}`,
        formatGraphDiff(diffGraphs(scope(prev), scope(current)))
    ].join('\n')
}

// ---- change impact -------------------------------------------------------------------------------
// Blast radius of a change, without any GitHub API: diff the CURRENT change (branch
// commits since the merge-base + staged/unstaged + untracked) against a base ref, map the changed
// files and their symbols onto the graph, and walk REVERSE dependency edges — everything the change
// can break, ranked by proximity + connectivity, with file-level test coverage attached so the
// untested part of the blast radius stands out. The pre-PR review, in one call.
export function tChangeImpact(g, args, ctx) {
    const baseline = tChangeImpactV2(g, args, ctx)
    return refineChangeImpact(g, args, ctx, baseline, tChangeImpactV2)
}
