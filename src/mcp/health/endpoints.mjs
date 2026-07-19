import {rawGraph} from '../graph-context.mjs'
import {analyzeEndpointInventory} from '../../analysis/endpoints.js'
import {toolResult} from '../tool-result.mjs'

export function tListEndpoints(g, args, ctx) {
    if (!ctx.repoRoot) return 'Endpoint detection needs the repo root (not provided to this server).'
    const graph = rawGraph(ctx)
    const codeFiles = [...new Set(
        (graph.nodes || [])
            .filter((n) => !String(n.id).includes('#') && n.source_file && n.file_type === 'code')
            .map((n) => n.source_file)
    )]
    const inventory = analyzeEndpointInventory(ctx.repoRoot, codeFiles)
    let eps = inventory.endpoints
    const method = args.method ? String(args.method).toUpperCase() : null
    const path = args.path ? String(args.path) : null
    if (method) eps = eps.filter((endpoint) => endpoint.method === method)
    if (path) eps = eps.filter((endpoint) => endpoint.path === path || endpoint.path.endsWith(path))
    if (!eps.length) return 'No HTTP endpoints detected in the indexed code files.'
    const max = Math.max(1, Math.min(300, Number(args.max_results) || 100))
    const shown = eps.slice(0, max)
    const stats = inventory.stats
    const text = [
        `${eps.length} endpoint(s) matched${eps.length > shown.length ? `, showing ${shown.length}` : ''}. Inventory: ${stats.declaredRoutes} declaration(s); ${stats.reachableStaticRoutes} statically reachable composed route(s); ${stats.localDeclarations} local/root declaration candidate(s); ${stats.staticMounts} static router mount(s)${stats.truncated ? `; TRUNCATED at ${stats.maxEndpoints}` : ''}.`,
        ...shown.map((e) => {
            const via = e.mountChain?.length
                ? `\n           declared ${e.declaredPath} in ${e.file}${e.line ? `:${e.line}` : ''}; mount chain ${e.mountChain.map((mount) => `${mount.file}:${mount.line} ${mount.path}`).join(' → ')}`
                : ''
            const activation = e.conditional
                ? `; conditional default ${e.defaultActive === false ? 'inactive' : e.defaultActive === true ? 'active' : 'unknown'}`
                : ''
            return `  ${e.method.toUpperCase().padEnd(6)} ${e.path}${e.handler ? `  → ${e.handler}` : ''}  (${e.file}${e.line ? `:${e.line}` : ''}; ${e.mountState}/${e.confidence}${activation})${via}`
        }),
    ].join('\n')
    return toolResult(text, {
        filters: {method, path},
        stats,
        endpoints: shown,
        page: {shown: shown.length, total: eps.length, truncated: eps.length > shown.length || stats.truncated},
    }, {completeness: {status: stats.truncated ? 'PARTIAL' : 'COMPLETE', reason: stats.truncated ? `endpoint cap ${stats.maxEndpoints} reached` : 'all indexed code files scanned'}})
}

