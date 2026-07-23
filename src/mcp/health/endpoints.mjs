import {rawGraph} from '../graph-context.mjs'
import {analyzeEndpointInventory} from '../../analysis/endpoints.js'
import {PATH_CLASS_NAMES, createPathClassifier, hasPathClass} from '../../path-classification.js'
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
    // Production-first: classified endpoints are suppressed by default; a tests-only graph would
    // suppress everything, so that build mode auto-includes them (same precedent as module_map).
    const includeClassified = args.include_classified === true || graph.graphBuildMode === 'tests-only'
    const classifier = createPathClassifier(ctx.repoRoot)
    const byFile = new Map()
    const classesOf = (file) => {
        const key = String(file || '')
        if (!byFile.has(key)) {
            const info = classifier.explain(key, {content: ''})
            byFile.set(key, {classified: info.excluded || hasPathClass(info, ...PATH_CLASS_NAMES), pathClasses: info.classes})
        }
        return byFile.get(key)
    }
    const production = eps.filter((endpoint) => !classesOf(endpoint.file).classified)
    const classified = eps.filter((endpoint) => classesOf(endpoint.file).classified)
    const suppressed = includeClassified ? 0 : classified.length
    eps = includeClassified ? [...production, ...classified] : production
    const suppressionNote = suppressed
        ? `${suppressed} endpoint(s) in classified test/e2e/generated/vendored/mock/story/docs/benchmark/temp or explicitly excluded paths were suppressed; pass include_classified:true to inspect them.`
        : ''
    if (!eps.length) return suppressed
        ? `No production HTTP endpoints detected; ${suppressionNote}`
        : 'No HTTP endpoints detected in the indexed code files.'
    const max = Math.max(1, Math.min(300, Number(args.max_results) || 100))
    const shown = eps.slice(0, max)
    const stats = inventory.stats
    const text = [
        `${eps.length} endpoint(s) matched${eps.length > shown.length ? `, showing ${shown.length}` : ''}. Inventory: ${stats.declaredRoutes} declaration(s); ${stats.reachableStaticRoutes} statically reachable composed route(s); ${stats.localDeclarations} local/root declaration candidate(s); ${stats.staticMounts} static router mount(s)${stats.truncated ? `; TRUNCATED at ${stats.maxEndpoints}` : ''}.${suppressed ? ` ${suppressionNote}` : ''}`,
        ...shown.map((e) => {
            const via = e.mountChain?.length
                ? `\n           declared ${e.declaredPath} in ${e.file}${e.line ? `:${e.line}` : ''}; mount chain ${e.mountChain.map((mount) => `${mount.file}:${mount.line} ${mount.path}`).join(' → ')}`
                : ''
            const activation = e.conditional
                ? `; conditional default ${e.defaultActive === false ? 'inactive' : e.defaultActive === true ? 'active' : 'unknown'}`
                : ''
            const info = classesOf(e.file)
            const tag = info.classified ? ` [classified${info.pathClasses.length ? `:${info.pathClasses.join('+')}` : ''}]` : ''
            return `  ${e.method.toUpperCase().padEnd(6)} ${e.path}${e.handler ? `  → ${e.handler}` : ''}  (${e.file}${e.line ? `:${e.line}` : ''}; ${e.mountState}/${e.confidence}${activation})${tag}${via}`
        }),
    ].join('\n')
    return toolResult(text, {
        filters: {method, path},
        stats,
        pathPolicy: includeClassified ? 'all' : 'production-first',
        suppressed,
        endpoints: shown.map((e) => {
            const info = classesOf(e.file)
            return info.classified ? {...e, classified: true, pathClasses: info.pathClasses} : e
        }),
        page: {shown: shown.length, total: eps.length, truncated: eps.length > shown.length || stats.truncated},
    }, {completeness: {status: stats.truncated ? 'PARTIAL' : 'COMPLETE', reason: stats.truncated ? `endpoint cap ${stats.maxEndpoints} reached` : 'all indexed code files scanned'}})
}
