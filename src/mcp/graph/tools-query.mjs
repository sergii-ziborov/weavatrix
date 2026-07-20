import {
    isSymbol, degreeOf, labelOf, resolveNode, findSeeds, resolveSeedFiles,
    undirectedNeighbors, requestedPathClasses,
} from '../graph-context.mjs'
import {createPathClassifier, hasPathClass} from '../../path-classification.js'

const QUERY_NON_PRODUCT = Object.freeze(['test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp'])
const LOW_SIGNAL_SYMBOL_RE = /^(?:const(?:ant)?|variable|property|field|enum_member)$/i
const querySourceFile = (node) => String(node?.source_file || String(node?.id || '').split('#', 1)[0]).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
const queryWords = (value) => new Set(String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean))
const exactSymbolName = (node) => {
    const match = String(node?.id || '').match(/#([^@]+)@/)
    return match ? match[1] : String(node?.label || '').replace(/\(\)$/, '')
}

function resolveExactSeedSymbols(g, requested, limit = 12) {
    const values = Array.isArray(requested) ? requested.slice(0, limit) : []
    const seeds = []
    const missing = []
    const ambiguous = []
    for (const raw of values) {
        const wanted = String(raw || '').trim()
        if (!wanted) continue
        let matches = []
        const byId = g.byId.get(wanted)
        if (byId && isSymbol(byId.id)) matches = [byId]
        else matches = g.nodes.filter((node) => isSymbol(node.id)
            && (String(node.label || '') === wanted || exactSymbolName(node) === wanted))
        if (matches.length === 1) {
            if (!seeds.some((seed) => String(seed.id) === String(matches[0].id))) seeds.push(matches[0])
        } else if (matches.length > 1) ambiguous.push(`${wanted} (${matches.length} exact matches; pass a symbol id)`)
        else missing.push(wanted)
    }
    return {seeds, missing, ambiguous}
}

const relationSet = (relationFilter, legacyFilter) => {
    const raw = relationFilter ?? legacyFilter
    const values = Array.isArray(raw) ? raw : (raw == null ? [] : String(raw).split(','))
    const normalized = values.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    return normalized.length ? new Set(normalized) : null
}

export function tQueryGraph(g, {
    question, mode = 'bfs', depth = 3, context_filter, relation_filter, seed_files, seed_symbols, augment_seeds = false,
    flow_direction = 'both', include_classified = false, include_low_signal = false, token_budget = 2000,
} = {}, toolCtx = {}) {
    const pinned = resolveSeedFiles(g, seed_files)
    const exactSymbols = resolveExactSeedSymbols(g, seed_symbols)
    const pinnedSeeds = [...pinned.seeds, ...exactSymbols.seeds.filter((node) => !pinned.seeds.some((seed) => String(seed.id) === String(node.id)))]
    const automatic = pinnedSeeds.length && augment_seeds !== true
        ? []
        : findSeeds(g, question, Math.max(0, 6 - pinnedSeeds.length), {repoRoot: toolCtx.repoRoot || null})
    const seeds = [...pinnedSeeds, ...automatic.filter((node) => !pinnedSeeds.some((seed) => String(seed.id) === String(node.id)))]
    if (!seeds.length) {
        const details = [
            pinned.missing.length ? `Unresolved seed files: ${pinned.missing.join(', ')}` : null,
            exactSymbols.missing.length ? `Unresolved exact symbols: ${exactSymbols.missing.join(', ')}` : null,
            exactSymbols.ambiguous.length ? `Ambiguous exact symbols: ${exactSymbols.ambiguous.join(', ')}` : null,
        ].filter(Boolean)
        return [`No nodes matched "${question || ''}".`, ...details].join('\n')
    }

    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3))
    const relations = relationSet(relation_filter, context_filter)
    const relationAllowed = (relation) => !relations || relations.has(String(relation ?? '').toLowerCase())
    const direction = ['forward', 'backward', 'both'].includes(String(flow_direction).toLowerCase())
        ? String(flow_direction).toLowerCase() : 'both'
    const neighbors = (id) => {
        const found = new Map()
        const add = (edges) => {
            for (const edge of edges || []) {
                const neighbor = String(edge.id)
                if (edge.barrelProxy === true || !relationAllowed(edge.relation) || found.has(neighbor)) continue
                found.set(neighbor, edge.relation)
            }
        }
        if (direction !== 'backward') add(g.out.get(id))
        if (direction !== 'forward') add(g.inn.get(id))
        return found
    }

    const requestedClasses = requestedPathClasses(question)
    const classifier = createPathClassifier(toolCtx.repoRoot || null)
    const classificationCache = new Map()
    const pinnedFiles = new Set(pinnedSeeds.map(querySourceFile))
    const classifiedSuppressed = new Set()
    const pathPolicy = (id) => {
        const node = g.byId.get(String(id))
        const file = querySourceFile(node)
        if (!file || pinnedFiles.has(file) || include_classified === true) return {ok: true}
        // Extractor-proven test symbols (Rust #[cfg(test)]) live in production files; suppress them
        // under the same policy as path-classified tests unless the question asks about tests.
        if (node?.test_surface === true && !requestedClasses.has('test')) {
            classifiedSuppressed.add(String(id))
            return {ok: false, bucket: 'classified'}
        }
        if (!classificationCache.has(file)) classificationCache.set(file, classifier.explain(file, {content: ''}))
        const info = classificationCache.get(file)
        const classes = QUERY_NON_PRODUCT.filter((name) => hasPathClass(info, name))
        if (!classes.length && !info?.excluded) return {ok: true}
        if (classes.some((name) => requestedClasses.has(name))) return {ok: true}
        classifiedSuppressed.add(String(id))
        return {ok: false, bucket: 'classified'}
    }

    const questionTerms = queryWords(question)
    const start = seeds.map((seed) => String(seed.id))
    const isLowSignal = (id) => {
        if (include_low_signal === true || start.includes(String(id))) return false
        const node = g.byId.get(String(id))
        if (!node || !isSymbol(node.id) || !LOW_SIGNAL_SYMBOL_RE.test(String(node.symbol_kind || ''))) return false
        const labelTerms = queryWords(node.label || String(node.id || '').split('#').pop() || '')
        if ([...questionTerms].some((term) => labelTerms.has(term))) return false
        return degreeOf(g, id) === 0
    }
    const charBudget = Math.max(400, (Number(token_budget) || 2000) * 4)
    const nodeBudget = Math.max(20, Math.min(120, Math.round((Number(token_budget) || 2000) / 40)))
    const depthOf = new Map()

    if (mode === 'dfs') {
        const stack = start.map((id) => ({id, depth: 0}))
        const seen = new Set()
        while (stack.length) {
            const {id, depth: currentDepth} = stack.pop()
            if (!depthOf.has(id) || currentDepth < depthOf.get(id)) depthOf.set(id, currentDepth)
            if (seen.has(id)) continue
            seen.add(id)
            if (currentDepth >= maxDepth) continue
            for (const [neighbor, relation] of neighbors(id)) {
                if (!relationAllowed(relation) || !pathPolicy(neighbor).ok) continue
                if (!seen.has(neighbor)) stack.push({id: neighbor, depth: currentDepth + 1})
            }
        }
    } else {
        let frontier = start.slice()
        start.forEach((id) => depthOf.set(id, 0))
        for (let currentDepth = 0; currentDepth < maxDepth && frontier.length; currentDepth++) {
            const next = []
            for (const id of frontier) {
                for (const [neighbor, relation] of neighbors(id)) {
                    if (!relationAllowed(relation) || !pathPolicy(neighbor).ok) continue
                    if (!depthOf.has(neighbor)) {
                        depthOf.set(neighbor, currentDepth + 1)
                        next.push(neighbor)
                    }
                }
            }
            frontier = next
        }
    }

    const reachedBeforeSignalFilter = depthOf.size
    const lowSignalSuppressed = [...depthOf.keys()].filter(isLowSignal).length
    const ranked = [...depthOf.entries()]
        .filter(([id]) => !isLowSignal(id))
        .map(([id, distance]) => ({id, distance, degree: degreeOf(g, id)}))
        .sort((a, b) => a.distance - b.distance || b.degree - a.degree)
    const shown = ranked.slice(0, nodeBudget)
    const shownIds = new Set(shown.map((node) => node.id))
    const edgeSeen = new Set()
    const shownEdges = []
    for (const source of shownIds) {
        for (const edge of g.out.get(source) || []) {
            const target = String(edge.id)
            if (edge.barrelProxy === true || !shownIds.has(target) || !relationAllowed(edge.relation)) continue
            const key = `${source}|${edge.relation}|${target}`
            if (edgeSeen.has(key)) continue
            edgeSeen.add(key)
            shownEdges.push([source, edge.relation, target])
            if (shownEdges.length >= 160) break
        }
        if (shownEdges.length >= 160) break
    }
    const head = [
        `Query: "${question || ''}" (${mode}, depth ${maxDepth}, flow ${direction}${relations ? `, relations ${[...relations].join('/')}` : ''})`,
        `Seeds: ${seeds.map((seed) => seed.label ?? seed.id).join(', ')}`,
        pinned.missing.length ? `Unresolved pinned seed files: ${pinned.missing.join(', ')}` : null,
        exactSymbols.missing.length ? `Unresolved exact seed symbols: ${exactSymbols.missing.join(', ')}` : null,
        exactSymbols.ambiguous.length ? `Ambiguous exact seed symbols: ${exactSymbols.ambiguous.join(', ')}` : null,
        `Reached ${reachedBeforeSignalFilter} policy-eligible nodes; showing ${shown.length} closest by proximity + connectivity, ${shownEdges.length} edges among them.`,
        classifiedSuppressed.size ? `Suppressed ${classifiedSuppressed.size} classified/non-product traversal node(s); ask for that class or pass include_classified:true.` : null,
        lowSignalSuppressed ? `Suppressed ${lowSignalSuppressed} unreferenced constant/field node(s) with no query-term match; pass include_low_signal:true to inspect them.` : null,
        include_classified === true ? 'Path policy: classified/non-product traversal explicitly enabled.' : `Path policy: production-first${requestedClasses.size ? `; explicit question classes enabled: ${[...requestedClasses].join(', ')}` : ''}.`,
        '',
        'Nodes:',
    ]
    const nodeLines = shown.map((node) => `  [d${node.distance}] ${labelOf(g, node.id)}  (deg ${node.degree})  [${node.id}]`)
    const edgeLines = ['', 'Edges:', ...shownEdges.map(([source, relation, target]) => `  ${labelOf(g, source)} --${relation || 'rel'}--> ${labelOf(g, target)}`)]
    let text = [...head.filter(Boolean), ...nodeLines, ...edgeLines].join('\n')
    if (text.length > charBudget) text = text.slice(0, charBudget) + `\n... (truncated to ~${token_budget} tokens)`
    return text
}

export function tShortestPath(g, {source, target, max_hops = 8} = {}) {
    const sourceNode = resolveNode(g, source)
    const targetNode = resolveNode(g, target)
    if (!sourceNode) return `Source "${source}" not found.`
    if (!targetNode) return `Target "${target}" not found.`
    const sourceId = String(sourceNode.id)
    const targetId = String(targetNode.id)
    if (sourceId === targetId) return `Source and target are the same node: ${sourceNode.label ?? sourceId}.`
    const limit = Math.max(1, Math.min(20, Number(max_hops) || 8))
    const previous = new Map([[sourceId, null]])
    const relationTo = new Map()
    let frontier = [sourceId]
    let hops = 0
    let found = false
    while (frontier.length && hops < limit && !found) {
        const next = []
        for (const id of frontier) {
            for (const [neighbor, relation] of undirectedNeighbors(g, id)) {
                if (previous.has(neighbor)) continue
                previous.set(neighbor, id)
                relationTo.set(neighbor, relation)
                if (neighbor === targetId) { found = true; break }
                next.push(neighbor)
            }
            if (found) break
        }
        frontier = next
        hops++
    }
    if (!previous.has(targetId)) return `No path found between "${sourceNode.label ?? sourceId}" and "${targetNode.label ?? targetId}" within ${limit} hops.`
    const path = []
    for (let current = targetId; current != null; current = previous.get(current)) path.unshift(current)
    const lines = path.map((id, index) => index === 0 ? `  ${labelOf(g, id)}` : `  --${relationTo.get(id) || 'rel'}--> ${labelOf(g, id)}`)
    return [`Shortest path (${path.length - 1} hops): ${sourceNode.label ?? sourceId} → ${targetNode.label ?? targetId}`, ...lines].join('\n')
}
