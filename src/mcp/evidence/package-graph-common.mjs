import {createHash} from 'node:crypto'
import {CAPS, STATE, compareText, safeToken} from '../evidence-snapshot.common.mjs'

export const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024
export const MAX_PACKAGE_RECORDS = 50_000
export const MAX_DEPENDENCY_DECLARATIONS = 200_000
export const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/

export const packageVersion = (value) => {
    const version = safeToken(value, 128)
    return version && PACKAGE_VERSION.test(version) ? version : null
}

export const emptyDeclarations = () => ({total: 0, resolved: 0, unresolved: 0, local: 0, optionalMissing: 0})

export function emptyGraph(state, reason, extras = {}) {
    const emptyCount = () => ({total: 0, returned: 0, truncated: false})
    return {
        state,
        ecosystem: 'npm',
        root: '(root)',
        ...extras,
        completeness: {
            nodes: emptyCount(),
            edges: emptyCount(),
            declarations: emptyDeclarations(),
            reasons: reason ? [reason] : [],
        },
        nodes: [],
        edges: [],
    }
}

export function normalizeLockPath(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null
    const raw = value.replace(/\\/g, '/')
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(raw)) return null
    const normalized = raw.replace(/\/$/, '')
    if (normalized === '') return ''
    const parts = normalized.split('/')
    return parts.every((part) => part && part !== '.' && part !== '..') ? normalized : null
}

export function packageNameFromPath(packagePath) {
    const match = packagePath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)
    const name = match?.[1]
    return name && name.length <= 256 && PACKAGE_NAME.test(name) ? name : null
}

export function packageId(name, version, packagePath) {
    const location = createHash('sha256').update(packagePath).digest('hex').slice(0, 12)
    return `npm:${name}@${version}:${location}`
}

export function parentInstallPath(packagePath) {
    const marker = packagePath.lastIndexOf('/node_modules/')
    return marker >= 0 ? packagePath.slice(0, marker) : ''
}

export function dependencyDeclarations(record) {
    const declarations = new Map()
    const add = (values, kind, replace = false) => {
        if (!values || typeof values !== 'object' || Array.isArray(values)) return
        for (const name of Object.keys(values)) {
            if (name.length > 256 || !PACKAGE_NAME.test(name)) continue
            if (replace || !declarations.has(name)) declarations.set(name, kind)
        }
    }
    add(record?.dependencies, 'runtime')
    add(record?.devDependencies, 'dev')
    add(record?.optionalDependencies, 'optional', true)
    if (record?.peerDependencies && typeof record.peerDependencies === 'object' && !Array.isArray(record.peerDependencies)) {
        for (const name of Object.keys(record.peerDependencies)) {
            if (name.length > 256 || !PACKAGE_NAME.test(name) || declarations.has(name)) continue
            const optional = record?.peerDependenciesMeta?.[name]?.optional === true
            declarations.set(name, optional ? 'optional-peer' : 'peer')
        }
    }
    return [...declarations].map(([name, kind]) => ({name, kind}))
        .sort((a, b) => compareText(a.name, b.name) || compareText(a.kind, b.kind))
}

export function finalizeGraph({externalNodes, edgeMap, declarations, reasons, lockfile, lockfileVersion}) {
    const allNodes = [...externalNodes.values()].sort((a, b) =>
        Number(b.direct) - Number(a.direct) || compareText(a.name, b.name) ||
        compareText(a.version, b.version) || compareText(a.id, b.id))
    const nodes = allNodes.slice(0, CAPS.packageGraphNodes)
    const nodeIds = new Set(nodes.map((node) => node.id))
    const allEdges = [...edgeMap.values()].sort((a, b) =>
        compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.kind, b.kind))
    const eligibleEdges = allEdges.filter((edge) =>
        (edge.from === '(root)' || nodeIds.has(edge.from)) && nodeIds.has(edge.to))
    const edges = eligibleEdges.slice(0, CAPS.packageGraphEdges)
    const nodesTruncated = nodes.length < allNodes.length
    const edgesTruncated = edges.length < allEdges.length
    if (nodesTruncated) reasons.push('PACKAGE_NODE_LIMIT_REACHED')
    if (edgesTruncated) reasons.push('PACKAGE_EDGE_LIMIT_REACHED')

    return {
        state: reasons.length ? STATE.PARTIAL : STATE.COMPLETE,
        ecosystem: 'npm',
        lockfile,
        lockfileVersion,
        root: '(root)',
        completeness: {
            nodes: {total: allNodes.length, returned: nodes.length, truncated: nodesTruncated},
            edges: {total: allEdges.length, returned: edges.length, truncated: edgesTruncated},
            declarations,
            reasons: [...new Set(reasons)].sort(compareText),
        },
        nodes,
        edges,
    }
}
