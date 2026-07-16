// Connectivity-hub reporting, split from the general graph query tools.
import {connList} from './graph-context.mjs'
import {createPathClassifier, hasPathClass} from '../path-classification.js'

const isCompileTimeEdge = (edge) => edge?.typeOnly === true || edge?.compileOnly === true
const NON_PRODUCT_CLASSES = Object.freeze(['test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp'])
const sourceFileOf = (node) => String(node?.source_file || (node?.file_type === 'code' ? node?.id : '') || '').replace(/\\/g, '/')

export function tGodNodes(g, {top_n = 10, include_classified = false} = {}, ctx = {}) {
    const n = Math.max(1, Math.min(100, Number(top_n) || 10))
    const classifier = createPathClassifier(ctx.repoRoot || null)
    const classificationByFile = new Map()
    const isNonProduct = (node) => {
        if (include_classified === true) return false
        const file = sourceFileOf(node)
        if (!file) return false
        if (!classificationByFile.has(file)) classificationByFile.set(file, classifier.explain(file))
        const info = classificationByFile.get(file)
        return info.excluded || hasPathClass(info, ...NON_PRODUCT_CLASSES)
    }
    const excludedIds = new Set(g.nodes.filter(isNonProduct).map((node) => String(node.id)))
    const scored = g.nodes
        .filter((node) => !excludedIds.has(String(node.id)))
        .map((node) => {
            // Coupling from a suppressed artifact must not inflate an otherwise valid product hub.
            const rawOuts = (g.out.get(String(node.id)) || []).filter((edge) => !excludedIds.has(String(edge.id)))
            const rawIns = (g.inn.get(String(node.id)) || []).filter((edge) => !excludedIds.has(String(edge.id)))
            const outs = connList(rawOuts)
            const ins = connList(rawIns)
            const ownedMethods = new Set(rawOuts.filter((e) => e.relation === 'method').map((e) => String(e.id)))
            const outIds = new Set(outs.map((e) => String(e.id)))
            const inIds = new Set(ins.map((e) => String(e.id)))
            const allIds = new Set([...outIds, ...inIds])
            const runtimeIds = new Set([...outs, ...ins].filter((e) => !isCompileTimeEdge(e)).map((e) => String(e.id)))
            const compileOnlyIds = new Set([...outs, ...ins].filter(isCompileTimeEdge).map((e) => String(e.id)))
            for (const id of runtimeIds) compileOnlyIds.delete(id)
            const occurrences = outs.length + ins.length
            return {
                node,
                deg: allIds.size,
                runtime: runtimeIds.size,
                compileOnly: compileOnlyIds.size,
                out: outIds.size,
                in: inIds.size,
                occurrences,
                ownedMethods: ownedMethods.size,
            }
        })
        .filter((entry) => entry.deg > 0 || entry.ownedMethods > 0)
        .sort((a, b) => b.runtime - a.runtime || b.deg - a.deg || b.ownedMethods - a.ownedMethods || b.occurrences - a.occurrences)
    const ranked = scored.slice(0, n)
    const rankedIds = new Set(ranked.map((entry) => String(entry.node.id)))
    // Unique neighbors measure coupling, but a large component repeatedly calling the same helper (for
    // example i18n) can still be a valuable complexity hotspot. Preserve that second lens explicitly
    // instead of letting repeated sites inflate the coupling rank.
    const occurrenceHotspots = scored
        .filter((entry) => !rankedIds.has(String(entry.node.id)))
        .filter((entry) => entry.occurrences >= 20 && entry.occurrences - entry.deg >= 10)
        .sort((a, b) => (b.occurrences - b.deg) - (a.occurrences - a.deg) || b.occurrences - a.occurrences)
        .slice(0, Math.min(5, n))
    return [
        `Top ${ranked.length} connectivity hubs (ranked by unique runtime call/import/reference neighbors; structural ownership shown separately):`,
        ...ranked.map(
            (r, i) =>
                `${String(i + 1).padStart(2)}. ${r.node.label ?? r.node.id}  (${r.deg} unique: ${r.runtime} runtime, ${r.compileOnly} compile-only; out ${r.out}, in ${r.in}; ${r.occurrences} edge occurrence${r.occurrences === 1 ? '' : 's'}${r.ownedMethods ? `; owns ${r.ownedMethods} method${r.ownedMethods === 1 ? '' : 's'}` : ''})  [${r.node.id}]`
        ),
        `Repeated call sites affect the occurrence count, not the connectivity rank; compile-only neighbors are secondary to runtime coupling.`,
        occurrenceHotspots.length ? `` : null,
        occurrenceHotspots.length ? `High occurrence hotspots outside the connectivity rank (repeated call/reference sites; complexity signal, not broader coupling):` : null,
        ...occurrenceHotspots.map((r) =>
            `  ${r.node.label ?? r.node.id}  (${r.occurrences} occurrences across ${r.deg} unique neighbors; ${r.occurrences - r.deg} repeats)  [${r.node.id}]`
        ),
        excludedIds.size > 0 && include_classified !== true
            ? `${excludedIds.size} node(s) classified as tests/e2e/generated/build output/mocks/stories/docs/benchmarks/temp or explicitly excluded were omitted; pass include_classified:true to inspect them.`
            : null,
    ].filter((line) => line != null).join('\n')
}
