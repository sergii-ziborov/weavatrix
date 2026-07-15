// Connectivity-hub reporting, split from the general graph query tools.
import {connList} from './graph-context.mjs'

const isCompileTimeEdge = (edge) => edge?.typeOnly === true || edge?.compileOnly === true

export function tGodNodes(g, {top_n = 10} = {}) {
    const n = Math.max(1, Math.min(100, Number(top_n) || 10))
    const scored = g.nodes
        .map((node) => {
            const rawOuts = g.out.get(String(node.id)) || []
            const rawIns = g.inn.get(String(node.id)) || []
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
    ].filter((line) => line != null).join('\n')
}
