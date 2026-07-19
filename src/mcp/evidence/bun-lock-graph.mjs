import {compareText, safeToken, STATE} from '../evidence-snapshot.common.mjs'
import {
    MAX_DEPENDENCY_DECLARATIONS, MAX_PACKAGE_RECORDS, PACKAGE_NAME,
    dependencyDeclarations, emptyDeclarations, emptyGraph, finalizeGraph,
    packageId, packageVersion,
} from './package-graph-common.mjs'

// Bun >= 1.2 writes JSONC: JSON plus comments and trailing commas.
export function parseJsonc(text) {
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    const out = []
    let i = 0
    const length = source.length
    const skipComment = (index) => {
        if (source[index] !== '/') return index
        if (source[index + 1] === '/') {
            let cursor = index + 2
            while (cursor < length && source[cursor] !== '\n') cursor++
            return cursor
        }
        if (source[index + 1] === '*') {
            let cursor = index + 2
            while (cursor < length && !(source[cursor] === '*' && source[cursor + 1] === '/')) cursor++
            return Math.min(cursor + 2, length)
        }
        return index
    }
    while (i < length) {
        const char = source[i]
        if (char === '"') {
            const start = i
            i++
            while (i < length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1
            i = Math.min(i + 1, length)
            out.push(source.slice(start, i))
            continue
        }
        if (char === '/') {
            const next = skipComment(i)
            if (next !== i) { i = next; continue }
        }
        if (char === ',') {
            let ahead = i + 1
            while (ahead < length) {
                if (/\s/.test(source[ahead])) { ahead++; continue }
                const next = skipComment(ahead)
                if (next !== ahead) { ahead = next; continue }
                break
            }
            if (ahead < length && (source[ahead] === '}' || source[ahead] === ']')) { i++; continue }
        }
        out.push(char)
        i++
    }
    return JSON.parse(out.join(''))
}

function bunKeySegments(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)) return null
    const parts = key.split('/')
    const segments = []
    for (let index = 0; index < parts.length; index++) {
        let segment = parts[index]
        if (segment.startsWith('@')) {
            if (index + 1 >= parts.length) return null
            segment = `${segment}/${parts[++index]}`
        }
        if (segment.length > 256 || !PACKAGE_NAME.test(segment)) return null
        segments.push(segment)
    }
    return segments
}

function bunPackageRecord(entry) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].length > 1024) return null
    const at = entry[0].lastIndexOf('@')
    if (at <= 0) return null
    const name = entry[0].slice(0, at)
    if (name.length > 256 || !PACKAGE_NAME.test(name)) return null
    const rawVersion = entry[0].slice(at + 1)
    const meta = entry.slice(1).find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {}
    return {name, rawVersion, workspace: rawVersion.startsWith('workspace:'), meta}
}

function bunDeclarationRecord(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
    const peerDependenciesMeta = {}
    if (Array.isArray(meta.optionalPeers)) {
        for (const name of meta.optionalPeers) if (typeof name === 'string') peerDependenciesMeta[name] = {optional: true}
    }
    return {
        dependencies: meta.dependencies,
        devDependencies: meta.devDependencies,
        optionalDependencies: meta.optionalDependencies,
        peerDependencies: meta.peerDependencies,
        peerDependenciesMeta,
    }
}

function resolveBunDependency(sourceSegments, name, records) {
    for (let depth = sourceSegments.length; depth >= 0; depth--) {
        const key = [...sourceSegments.slice(0, depth), name].join('/')
        const record = records.get(key)
        if (record) return {key, record}
    }
    return null
}

function applyBunReachabilityFlags(nodes, edges) {
    const adjacency = new Map()
    for (const edge of edges) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
        adjacency.get(edge.from).push(edge)
    }
    const reach = (excluded) => {
        const seen = new Set(['(root)'])
        const queue = ['(root)']
        while (queue.length) {
            for (const edge of adjacency.get(queue.pop()) || []) {
                if (excluded.has(edge.kind) || seen.has(edge.to)) continue
                seen.add(edge.to)
                queue.push(edge.to)
            }
        }
        return seen
    }
    const withoutDev = reach(new Set(['dev']))
    const withoutOptional = reach(new Set(['optional', 'optional-peer']))
    const withoutPeer = reach(new Set(['peer', 'optional-peer']))
    for (const node of nodes) {
        node.dev = !withoutDev.has(node.id)
        node.optional = !withoutOptional.has(node.id)
        node.peer = !withoutPeer.has(node.id)
    }
}

export function parseBunLock(lock, lockfile) {
    const lockfileVersion = Number(lock?.lockfileVersion)
    const extras = {lockfile, lockfileVersion: Number.isFinite(lockfileVersion) ? Math.trunc(lockfileVersion) : 0}
    if (!lock?.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
        return emptyGraph(STATE.PARTIAL, 'BUN_LOCK_PACKAGES_REQUIRED', extras)
    }
    const allKeys = Object.keys(lock.packages).sort(compareText)
    const selectedKeys = allKeys.slice(0, MAX_PACKAGE_RECORDS)
    const reasons = []
    if (selectedKeys.length < allKeys.length) reasons.push('LOCKFILE_PACKAGE_RECORD_LIMIT_REACHED')
    const records = new Map()
    let invalidRecords = 0
    for (const key of selectedKeys) {
        const segments = bunKeySegments(key)
        const record = segments ? bunPackageRecord(lock.packages[key]) : null
        if (!record) { invalidRecords++; continue }
        records.set(key, {...record, segments})
    }
    if (invalidRecords > 0) reasons.push('INVALID_LOCKFILE_PACKAGE_RECORDS')
    const externalNodes = new Map()
    let invalidPackageVersions = 0
    for (const [key, record] of records) {
        if (record.workspace) continue
        const version = packageVersion(record.rawVersion)
        if (!version) { invalidPackageVersions++; continue }
        externalNodes.set(key, {
            id: packageId(record.name, version, key), name: record.name, version,
            direct: false, dev: false, optional: false, peer: false,
        })
    }
    if (invalidPackageVersions > 0) reasons.push('INVALID_LOCKFILE_PACKAGE_VERSIONS')
    const workspaces = lock?.workspaces && typeof lock.workspaces === 'object' && !Array.isArray(lock.workspaces)
        ? lock.workspaces : null
    if (!workspaces) reasons.push('BUN_LOCK_WORKSPACES_MISSING')
    const sources = []
    for (const path of Object.keys(workspaces || {}).sort(compareText)) {
        const meta = workspaces[path]
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue
        const workspaceName = path === '' ? null : safeToken(meta.name)
        const segments = workspaceName && records.has(workspaceName) ? [workspaceName] : []
        sources.push({sourceId: '(root)', segments, declarationRecord: bunDeclarationRecord(meta)})
    }
    for (const [key, record] of [...records].sort(([a], [b]) => compareText(a, b))) {
        const node = externalNodes.get(key)
        if (node) sources.push({sourceId: node.id, segments: record.segments, declarationRecord: bunDeclarationRecord(record.meta)})
    }
    const edgeMap = new Map()
    const declarations = emptyDeclarations()
    let declarationLimitReached = false
    outer: for (const source of sources) {
        for (const declaration of dependencyDeclarations(source.declarationRecord)) {
            if (declarations.total >= MAX_DEPENDENCY_DECLARATIONS) { declarationLimitReached = true; break outer }
            declarations.total++
            const resolved = resolveBunDependency(source.segments, declaration.name, records)
            if (resolved?.record.workspace) { declarations.local++; continue }
            const node = resolved ? externalNodes.get(resolved.key) : null
            if (!node) {
                if (declaration.kind === 'optional' || declaration.kind === 'optional-peer') declarations.optionalMissing++
                else declarations.unresolved++
                continue
            }
            declarations.resolved++
            if (source.sourceId === '(root)') node.direct = true
            if (source.sourceId === node.id) continue
            const edge = {from: source.sourceId, to: node.id, kind: declaration.kind}
            edgeMap.set(`${edge.from}\0${edge.to}\0${edge.kind}`, edge)
        }
    }
    if (declarationLimitReached) reasons.push('LOCKFILE_DEPENDENCY_DECLARATION_LIMIT_REACHED')
    if (declarations.unresolved > 0) reasons.push('UNRESOLVED_LOCKFILE_DEPENDENCIES')
    applyBunReachabilityFlags(externalNodes.values(), edgeMap.values())
    return finalizeGraph({externalNodes, edgeMap, declarations, reasons, lockfile, lockfileVersion: extras.lockfileVersion})
}
