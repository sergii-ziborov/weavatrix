import {
    CAPS, PACKAGE_DEPENDENCY_KINDS, bool, checks, compare, count, int, list,
    numericRecord, packageName, packageVersion, path, reasons, set, state, text,
    token, verdict,
} from './evidence-common.mjs'

const PACKAGE_SOURCES = new Set(['package-lock', 'yarn-lock', 'requirements', 'venv', 'poetry-lock', 'uv-lock', 'pipfile-lock', 'go-sum', 'go-mod', 'node_modules'])

function packageSource(value) {
    const source = text(value, 512)
    if (PACKAGE_SOURCES.has(source)) return source
    const relative = path(source, 512)
    return relative && /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|requirements[\w.-]*\.(?:txt|in)|poetry\.lock|uv\.lock|Pipfile\.lock|go\.(?:mod|sum))$/i.test(relative) ? relative : undefined
}

function packageFact(value) {
    const name = packageName(value?.name), version = token(value?.version, 128), ecosystem = token(value?.ecosystem, 64), source = packageSource(value?.source)
    return name && version && ecosystem && source ? {name, version, ecosystem, dev: bool(value.dev), source} : null
}

function usage(value) {
    const name = packageName(value?.name), ecosystem = token(value?.ecosystem, 64)
    if (!name || !ecosystem) return null
    const files = [...new Set((value.files || []).map((item) => path(item)).filter(Boolean))].sort(compare)
    return {name, ecosystem, importCount: int(value.importCount), fileCount: int(value.fileCount), files: files.slice(0, CAPS.files), filesTruncated: bool(value.filesTruncated) || files.length > CAPS.files, kinds: [...new Set((value.kinds || []).map((item) => token(item, 64)).filter(Boolean))].sort(compare).slice(0, 32)}
}

function packageGraphNode(value) {
    const name = packageName(value?.name), version = packageVersion(value?.version), id = text(value?.id, 512)
    if (!name || !version || !id) return null
    const prefix = `npm:${name}@${version}:`
    if (!id.startsWith(prefix) || !/^[a-f0-9]{12}$/i.test(id.slice(prefix.length))) return null
    return {id, name, version, direct: bool(value.direct), dev: bool(value.dev), optional: bool(value.optional), peer: bool(value.peer)}
}

function sanitizePackageDependencyGraph(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            state: 'NOT_CHECKED', ecosystem: 'npm', root: '(root)',
            completeness: {nodes: count(null, 0, 0), edges: count(null, 0, 0), declarations: numericRecord(null, ['total', 'resolved', 'unresolved', 'local', 'optionalMissing']), reasons: ['DEPENDENCY_GRAPH_NOT_PROVIDED']},
            nodes: [], edges: [],
        }
    }
    const nodes = list(value.nodes, CAPS.packageGraphNodes, packageGraphNode,
        (a, b) => Number(b.direct) - Number(a.direct) || compare(a.name, b.name) || compare(a.version, b.version) || compare(a.id, b.id))
    const nodeIds = new Set(nodes.items.map((node) => node.id))
    const edge = (candidate) => {
        const from = candidate?.from === '(root)' ? '(root)' : text(candidate?.from, 512)
        const to = text(candidate?.to, 512), kind = token(candidate?.kind, 32)
        if (!from || !to || !PACKAGE_DEPENDENCY_KINDS.has(kind) || from === to ||
            (from !== '(root)' && !nodeIds.has(from)) || !nodeIds.has(to)) return null
        return {from, to, kind}
    }
    const edges = list(value.edges, CAPS.packageGraphEdges, edge,
        (a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind))
    const lockfile = path(value.lockfile, 512)
    const safeLockfile = lockfile && /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/i.test(lockfile) ? lockfile : undefined
    const graphState = state(value.state)
    const truncated = nodes.truncated || edges.truncated
    const out = {
        state: truncated && graphState === 'COMPLETE' ? 'PARTIAL' : graphState,
        ecosystem: 'npm', root: '(root)',
        completeness: {
            nodes: count(value?.completeness?.nodes, nodes.total, nodes.items.length),
            edges: count(value?.completeness?.edges, edges.total, edges.items.length),
            declarations: numericRecord(value?.completeness?.declarations, ['total', 'resolved', 'unresolved', 'local', 'optionalMissing']),
            reasons: reasons(value?.completeness?.reasons),
        },
        nodes: nodes.items, edges: edges.items,
    }
    set(out, 'lockfile', safeLockfile)
    const lockfileVersion = int(value.lockfileVersion)
    if (lockfileVersion > 0) out.lockfileVersion = lockfileVersion
    return out
}

export function sanitizePackages(value) {
    const inventory = list(value?.inventory, CAPS.packages, packageFact, (a, b) => compare(a.ecosystem, b.ecosystem) || compare(a.name, b.name) || compare(a.version, b.version))
    const directUsage = list(value?.directUsage, CAPS.usage, usage, (a, b) => compare(a.ecosystem, b.ecosystem) || compare(a.name, b.name))
    const dependencyGraph = sanitizePackageDependencyGraph(value?.dependencyGraph)
    const outState = state(value?.state)
    const truncated = inventory.truncated || directUsage.truncated || (dependencyGraph.state === 'PARTIAL' && value?.dependencyGraph?.state === 'COMPLETE')
    return {
        state: truncated && outState === 'COMPLETE' ? 'PARTIAL' : outState,
        verdict: verdict(value?.verdict),
        completeness: {
            inventory: count(value?.completeness?.inventory, inventory.total, inventory.items.length),
            directUsage: count(value?.completeness?.directUsage, directUsage.total, directUsage.items.length),
            dependencyGraphNodes: count(value?.completeness?.dependencyGraphNodes, dependencyGraph.completeness.nodes.total, dependencyGraph.nodes.length),
            dependencyGraphEdges: count(value?.completeness?.dependencyGraphEdges, dependencyGraph.completeness.edges.total, dependencyGraph.edges.length),
            reasons: reasons(value?.completeness?.reasons),
        },
        checks: checks(value?.checks), inventory: inventory.items, directUsage: directUsage.items, dependencyGraph,
    }
}
