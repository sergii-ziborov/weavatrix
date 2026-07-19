import {isStructuralRelation} from '../graph/relations.js'
import {querySymbolsPrecision} from '../precision/symbol-query.js'

export function graphWithExactDirectReferences(g, targetId, overlay) {
    const exact = (overlay?.links || []).filter((link) => String(link?.target || '') === targetId
        && link.provenance === 'EXACT_LSP')
    const provenEmpty = overlay?.state === 'COMPLETE'
        && (overlay?.noReferenceSymbols || []).some((id) => String(id) === targetId)
    if (overlay?.state !== 'COMPLETE' || (!exact.length && !provenEmpty)) return null
    const inn = new Map(g.inn)
    const structural = (g.inn.get(targetId) || []).filter((edge) => isStructuralRelation(edge.relation))
    inn.set(targetId, [...structural, ...exact.map((link) => ({
        id: String(link.source),
        relation: link.relation || 'references',
        provenance: 'EXACT_LSP',
        ...(link.typeOnly === true ? {typeOnly: true} : {}),
        ...(link.compileOnly === true ? {compileOnly: true} : {}),
    }))])
    return {...g, inn}
}

export function refineChangeImpact(g, args, ctx, baseline, computeImpact) {
    const requested = ['auto', 'graph', 'lsp'].includes(args?.precision) ? args.precision : 'auto'
    if (requested === 'graph' || !baseline?.result?.seeds?.ids || !ctx?.repoRoot || !ctx?.graphPath
        || (requested === 'auto' && g.graphPrecisionMode === 'off')) return baseline
    const targets = baseline.result.seeds.ids.filter((id) => {
        const node = g.byId.get(String(id))
        return node?.selection_start && /\.(?:[cm]?[jt]sx?)$/i.test(String(node.source_file || ''))
    }).slice(0, 16)
    if (!targets.length) return baseline
    return (async () => {
        try {
            const precision = await querySymbolsPrecision({
                repoRoot: ctx.repoRoot,
                graphPath: ctx.graphPath,
                targetIds: targets,
                maxReferences: Math.max(100, Math.min(16_384, Number(args.max_references) || 5_000)),
                timeoutMs: Math.max(1_000, Math.min(60_000, Number(args.timeout_ms) || 45_000)),
                clientFactory: ctx.precisionClientFactory,
            })
            let exactGraph = g
            const verified = []
            for (const target of targets) {
                const next = graphWithExactDirectReferences(exactGraph, String(target), precision.overlay)
                if (!next) continue
                exactGraph = next
                verified.push(String(target))
            }
            const value = verified.length ? computeImpact(exactGraph, args, ctx) : baseline
            const allVerified = verified.length === targets.length
            const status = allVerified ? 'DIRECT_EXACT_TRANSITIVE_GRAPH' : 'PARTIAL'
            value.text = [
                value.text.split('\n')[0],
                `Semantic precision: ${status}; EXACT_LSP verified direct references for ${verified.length}/${targets.length} changed JavaScript/TypeScript symbol(s). Transitive hops remain graph-backed.`,
                ...value.text.split('\n').slice(1),
            ].join('\n')
            value.result.semanticPrecision = {
                status,
                requestedTargets: targets,
                verifiedTargets: verified,
                exactDirectEdges: (precision.overlay?.links || []).filter((link) => verified.includes(String(link?.target || ''))).length,
                transitiveEvidence: 'GRAPH',
                provider: precision.overlay?.engines?.[0]?.provider || null,
                elapsedMs: precision.elapsedMs,
            }
            if (!allVerified) value.warnings.push({
                code: 'CHANGE_IMPACT_PRECISION_PARTIAL',
                message: precision.overlay?.reason || 'Not every changed symbol had complete exact direct-reference evidence.',
            })
            return value
        } catch (error) {
            const reason = error?.message || 'batch point query failed'
            baseline.result.semanticPrecision = {
                status: 'UNAVAILABLE', requestedTargets: targets, verifiedTargets: [],
                exactDirectEdges: 0, transitiveEvidence: 'GRAPH', reason,
            }
            baseline.warnings.push({
                code: 'CHANGE_IMPACT_PRECISION_UNAVAILABLE',
                message: `Exact changed-symbol references were unavailable; graph evidence was retained (${reason}).`,
            })
            baseline.text = [
                baseline.text.split('\n')[0],
                `Semantic precision: UNAVAILABLE; graph evidence retained (${reason}).`,
                ...baseline.text.split('\n').slice(1),
            ].join('\n')
            return baseline
        }
    })()
}
