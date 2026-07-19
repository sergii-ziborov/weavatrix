import {posix} from 'node:path'
import {analyzeEndpointInventory} from '../analysis/endpoints.js'
import {createPathClassifier, hasPathClass} from '../path-classification.js'
import {sourceExcerpt} from './tools-source.mjs'
import {toolResult} from './tool-result.mjs'

const NON_PRODUCT = ['test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp']

const symbolLine = (node) => Number(String(node?.source_location || '').match(/L(\d+)/)?.[1]
    || String(node?.id || '').match(/@(\d+)$/)?.[1] || 0)

const symbolName = (node) => String(node?.label || node?.id || '')
    .replace(/\([^)]*\).*$/, '')
    .split(/[.#]/).at(-1)
    .trim()

function codeFiles(graph) {
    return [...new Set((graph?.nodes || [])
        .filter((node) => !String(node.id).includes('#') && node.source_file && node.file_type === 'code')
        .map((node) => node.source_file))]
}

function endpointCandidates(inventory, args) {
    const path = String(args.path || '').trim()
    const method = args.method ? String(args.method).toUpperCase() : null
    if (!path) return []
    const eligible = inventory.endpoints.filter((endpoint) => !method || endpoint.method === method)
    const exact = eligible.filter((endpoint) => endpoint.path === path)
    return exact.length ? exact : eligible.filter((endpoint) => endpoint.path.endsWith(path))
}

function handlerCandidates(graph, endpoint) {
    if (!endpoint.handler) return []
    const wanted = endpoint.handler.toLowerCase()
    const qualifier = String(endpoint.handlerRef || '').split('.').slice(-2, -1)[0]?.toLowerCase() || ''
    const routeDir = posix.dirname(endpoint.file)
    const scored = (graph.nodes || [])
        .filter((node) => String(node.id).includes('#') && node.source_file && symbolName(node).toLowerCase() === wanted)
        .map((node) => {
            const file = String(node.source_file).replace(/\\/g, '/')
            let score = 0
            if (file === endpoint.file) score += 100
            if (posix.dirname(file) === routeDir) score += 40
            if (file.startsWith(`${routeDir}/`)) score += 15
            if (qualifier) {
                const basename = posix.basename(file).replace(/\.[^.]+$/, '').toLowerCase()
                if (basename === qualifier || basename.endsWith(`.${qualifier}`) || basename.endsWith(`-${qualifier}`)) score += 60
            }
            const line = symbolLine(node)
            if (file === endpoint.file && line >= endpoint.line && line - endpoint.line <= 250) score += 20
            return {node, score}
        })
        .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)))
    if (!scored.length) return []
    const best = scored[0].score
    return scored.filter((item) => item.score === best).map((item) => item.node)
}

function traceCalls(graph, start, {maxDepth, maxNodes, includeClassified, repoRoot}) {
    const classifier = createPathClassifier(repoRoot)
    const allowed = (node) => {
        if (!node?.source_file) return false
        if (includeClassified) return true
        const info = classifier.explain(node.source_file, {content: ''})
        return !info?.excluded && !NON_PRODUCT.some((name) => hasPathClass(info, name))
    }
    const queue = [{id: String(start.id), depth: 0}]
    const seen = new Set([String(start.id)])
    const edges = []
    let truncated = false
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor]
        if (current.depth >= maxDepth) continue
        const outgoing = (graph.out.get(current.id) || [])
            .filter((edge) => edge.relation === 'calls' && edge.typeOnly !== true && edge.compileOnly !== true && edge.barrelProxy !== true)
            .map((edge) => ({edge, target: graph.byId.get(String(edge.id))}))
            .filter(({target}) => target && String(target.id).includes('#') && allowed(target))
            .sort((a, b) => (Number(a.edge.line) || 0) - (Number(b.edge.line) || 0) || String(a.target.id).localeCompare(String(b.target.id)))
        const unique = new Set()
        for (const {edge, target} of outgoing) {
            const targetId = String(target.id)
            if (unique.has(targetId)) continue
            unique.add(targetId)
            if (edges.length >= maxNodes - 1) { truncated = true; break }
            edges.push({
                from: current.id,
                to: targetId,
                depth: current.depth + 1,
                relation: edge.relation,
                provenance: edge.provenance || 'UNKNOWN',
                line: Number(edge.line) || symbolLine(graph.byId.get(current.id)) || 1,
            })
            if (!seen.has(targetId)) {
                seen.add(targetId)
                queue.push({id: targetId, depth: current.depth + 1})
            }
            if (unique.size >= 6) { truncated = outgoing.length > unique.size; break }
        }
        if (truncated && edges.length >= maxNodes - 1) break
    }
    return {edges, truncated, nodeCount: seen.size}
}

function endpointLine(endpoint) {
    const mount = endpoint.mountChain?.length
        ? endpoint.mountChain.map((item) => `${item.file}:${item.line} ${item.path}`).join(' → ')
        : 'no static router mount chain'
    const activation = endpoint.conditional
        ? `; conditional default ${endpoint.defaultActive === false ? 'inactive' : endpoint.defaultActive === true ? 'active' : 'unknown'}`
        : ''
    return `${endpoint.method} ${endpoint.path} → ${endpoint.handler || 'inline/unknown'} (${endpoint.file}:${endpoint.line}; ${endpoint.mountState}/${endpoint.confidence}${activation}; declared ${endpoint.declaredPath}; ${mount})`
}

export function tTraceEndpoint(graph, args, ctx) {
    if (!ctx?.repoRoot) return 'Endpoint tracing needs the repo root (not provided to this server).'
    const inventory = analyzeEndpointInventory(ctx.repoRoot, codeFiles(graph))
    const candidates = endpointCandidates(inventory, args)
    if (!candidates.length) return toolResult(`No endpoint matched ${args.method ? `${String(args.method).toUpperCase()} ` : ''}${args.path || '(missing path)'}.`, {
        status: 'NOT_FOUND', query: {path: args.path || null, method: args.method || null}, inventory: inventory.stats,
    })
    if (candidates.length > 1) return toolResult([
        `Endpoint query is ambiguous (${candidates.length} matches). Pass the exact composed path and method:`,
        ...candidates.slice(0, 20).map((endpoint) => `  ${endpointLine(endpoint)}`),
    ].join('\n'), {status: 'AMBIGUOUS', candidates: candidates.slice(0, 20), inventory: inventory.stats}, {
        completeness: {status: 'PARTIAL', reason: 'ambiguous endpoint'},
    })
    const endpoint = candidates[0]
    const handlers = handlerCandidates(graph, endpoint)
    if (handlers.length !== 1) return toolResult([
        `Endpoint resolved, but its handler symbol is ${handlers.length ? 'ambiguous' : 'not present in the graph'}:`,
        `  ${endpointLine(endpoint)}`,
        ...handlers.slice(0, 12).map((node) => `  candidate ${node.label || node.id} (${node.source_file}:${symbolLine(node) || '?'}) [${node.id}]`),
    ].join('\n'), {status: handlers.length ? 'AMBIGUOUS_HANDLER' : 'HANDLER_NOT_FOUND', endpoint, handlers}, {
        completeness: {status: 'PARTIAL', reason: handlers.length ? 'ambiguous handler symbol' : 'handler symbol not found'},
    })

    const maxDepth = Math.max(1, Math.min(4, Number(args.max_depth) || 3))
    const maxNodes = Math.max(2, Math.min(40, Number(args.max_nodes) || 20))
    const contextLines = Math.max(0, Math.min(6, Number(args.context_lines) || 2))
    const maxExcerpts = Math.max(0, Math.min(12, Number(args.max_excerpts) || 6))
    const handler = handlers[0]
    const traced = traceCalls(graph, handler, {
        maxDepth, maxNodes, includeClassified: args.include_classified === true, repoRoot: ctx.repoRoot,
    })
    const excerpts = traced.edges.slice(0, maxExcerpts).map((edge) => {
        const source = graph.byId.get(edge.from)
        return sourceExcerpt(ctx.repoRoot, source?.source_file, edge.line, contextLines)
    }).filter(Boolean)
    const lines = [
        `Endpoint trace (${traced.truncated ? 'PARTIAL' : 'COMPLETE'}; depth ≤${maxDepth}, nodes ${traced.nodeCount}/${maxNodes}):`,
        `  ${endpointLine(endpoint)}`,
        `  handler ${handler.label || handler.id} (${handler.source_file}:${symbolLine(handler) || '?'}) [${handler.id}]`,
        traced.edges.length ? 'Call graph:' : 'Call graph: no outgoing call edges from the resolved handler.',
        ...traced.edges.map((edge) => {
            const from = graph.byId.get(edge.from), to = graph.byId.get(edge.to)
            return `  ${'  '.repeat(Math.max(0, edge.depth - 1))}${from?.label || edge.from} → ${to?.label || edge.to} (${from?.source_file}:${edge.line}; ${edge.provenance})`
        }),
        ...excerpts.flatMap((excerpt) => ['', `Call-site excerpt (${excerpt.file}:${excerpt.startLine}-${excerpt.endLine}, focus ${excerpt.focusLine}):`, excerpt.text]),
    ]
    return toolResult(lines.join('\n'), {
        status: traced.truncated ? 'PARTIAL' : 'COMPLETE', endpoint, handler: {
            id: String(handler.id), label: handler.label || String(handler.id), file: handler.source_file, line: symbolLine(handler),
        }, trace: traced, excerpts, inventory: inventory.stats,
    }, {completeness: {status: traced.truncated ? 'PARTIAL' : 'COMPLETE', reason: traced.truncated ? 'bounded trace cap reached' : 'bounded outgoing call graph exhausted'}})
}
