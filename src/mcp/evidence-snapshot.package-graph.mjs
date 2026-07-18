import {createHash} from 'node:crypto'
import {readFileSync, statSync} from 'node:fs'
import {createRepoBoundary} from '../repo-path.js'
import {CAPS, STATE, compareText, safeToken} from './evidence-snapshot.common.mjs'

const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json', 'bun.lock']
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024
const MAX_PACKAGE_RECORDS = 50_000
const MAX_DEPENDENCY_DECLARATIONS = 200_000
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/

const packageVersion = (value) => {
    const version = safeToken(value, 128)
    return version && PACKAGE_VERSION.test(version) ? version : null
}

const emptyCount = () => ({total: 0, returned: 0, truncated: false})
const emptyDeclarations = () => ({total: 0, resolved: 0, unresolved: 0, local: 0, optionalMissing: 0})

function emptyGraph(state, reason, extras = {}) {
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

function normalizeLockPath(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null
    const raw = value.replace(/\\/g, '/')
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(raw)) return null
    const normalized = raw.replace(/\/$/, '')
    if (normalized === '') return ''
    const parts = normalized.split('/')
    return parts.every((part) => part && part !== '.' && part !== '..') ? normalized : null
}

function packageNameFromPath(packagePath) {
    const match = packagePath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)
    const name = match?.[1]
    return name && name.length <= 256 && PACKAGE_NAME.test(name) ? name : null
}

function packageId(name, version, packagePath) {
    const location = createHash('sha256').update(packagePath).digest('hex').slice(0, 12)
    return `npm:${name}@${version}:${location}`
}

function parentInstallPath(packagePath) {
    const marker = packagePath.lastIndexOf('/node_modules/')
    return marker >= 0 ? packagePath.slice(0, marker) : ''
}

function dependencyDeclarations(record) {
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

function resolveDependency(sourcePath, name, records, externalNodes) {
    let cursor = sourcePath
    const seen = new Set()
    while (!seen.has(cursor)) {
        seen.add(cursor)
        const candidate = cursor ? `${cursor}/node_modules/${name}` : `node_modules/${name}`
        const record = records.get(candidate)
        if (record) {
            if (record.link === true) return {kind: 'local'}
            const node = externalNodes.get(candidate)
            return node ? {kind: 'external', node} : {kind: 'unresolved'}
        }
        if (!cursor) break
        cursor = parentInstallPath(cursor)
    }
    return {kind: 'unresolved'}
}

function parseLock(lock, lockfile) {
    const lockfileVersion = Number(lock?.lockfileVersion || 0)
    const extras = {lockfile, lockfileVersion: Number.isFinite(lockfileVersion) ? Math.trunc(lockfileVersion) : 0}
    if (![2, 3].includes(lockfileVersion) || !lock?.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
        return emptyGraph(STATE.PARTIAL, 'PACKAGE_LOCK_V2_V3_REQUIRED', extras)
    }

    const allKeys = Object.keys(lock.packages).sort(compareText)
    const selectedKeys = allKeys.slice(0, MAX_PACKAGE_RECORDS)
    const reasons = []
    if (selectedKeys.length < allKeys.length) reasons.push('LOCKFILE_PACKAGE_RECORD_LIMIT_REACHED')

    const records = new Map()
    let invalidRecords = 0
    for (const rawPath of selectedKeys) {
        const packagePath = normalizeLockPath(rawPath)
        const record = lock.packages[rawPath]
        if (packagePath == null || !record || typeof record !== 'object' || Array.isArray(record)) {
            invalidRecords++
            continue
        }
        const insideNodeModules = packagePath.startsWith('node_modules/') || packagePath.includes('/node_modules/')
        if (insideNodeModules && !packageNameFromPath(packagePath)) {
            invalidRecords++
            continue
        }
        if (records.has(packagePath)) {
            invalidRecords++
            continue
        }
        records.set(packagePath, record)
    }
    if (invalidRecords > 0) reasons.push('INVALID_LOCKFILE_PACKAGE_RECORDS')

    const externalNodes = new Map()
    let invalidPackageVersions = 0
    for (const [packagePath, record] of records) {
        const name = packageNameFromPath(packagePath)
        const version = packageVersion(record.version)
        if (!name || record.link === true) continue
        if (!version) { invalidPackageVersions++; continue }
        externalNodes.set(packagePath, {
            id: packageId(name, version, packagePath),
            name,
            version,
            direct: false,
            dev: record.dev === true || record.devOptional === true,
            optional: record.optional === true || record.devOptional === true,
            peer: record.peer === true,
        })
    }
    if (invalidPackageVersions > 0) reasons.push('INVALID_LOCKFILE_PACKAGE_VERSIONS')

    const edgeMap = new Map()
    const declarations = emptyDeclarations()
    let declarationLimitReached = false
    const sources = [...records].filter(([packagePath]) =>
        packageNameFromPath(packagePath) == null || externalNodes.has(packagePath))
        .sort(([a], [b]) => compareText(a, b))

    outer: for (const [sourcePath, record] of sources) {
        const sourceNode = externalNodes.get(sourcePath)
        const sourceId = sourceNode?.id || '(root)'
        for (const declaration of dependencyDeclarations(record)) {
            if (declarations.total >= MAX_DEPENDENCY_DECLARATIONS) {
                declarationLimitReached = true
                break outer
            }
            declarations.total++
            const resolved = resolveDependency(sourcePath, declaration.name, records, externalNodes)
            if (resolved.kind === 'local') {
                declarations.local++
                continue
            }
            if (resolved.kind !== 'external') {
                if (declaration.kind === 'optional' || declaration.kind === 'optional-peer') declarations.optionalMissing++
                else declarations.unresolved++
                continue
            }
            declarations.resolved++
            if (sourceId === '(root)') resolved.node.direct = true
            if (sourceId === resolved.node.id) continue
            const edge = {from: sourceId, to: resolved.node.id, kind: declaration.kind}
            edgeMap.set(`${edge.from}\0${edge.to}\0${edge.kind}`, edge)
        }
    }
    if (declarationLimitReached) reasons.push('LOCKFILE_DEPENDENCY_DECLARATION_LIMIT_REACHED')
    if (declarations.unresolved > 0) reasons.push('UNRESOLVED_LOCKFILE_DEPENDENCIES')

    return finalizeGraph({externalNodes, edgeMap, declarations, reasons, lockfile, lockfileVersion})
}

function finalizeGraph({externalNodes, edgeMap, declarations, reasons, lockfile, lockfileVersion}) {
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

// Bun >= 1.2 writes a text lockfile (bun.lock) as JSONC: JSON plus comments and
// trailing commas. parseJsonc strips both (outside of strings) with no new deps.
function parseJsonc(text) {
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

// bun.lock package keys are slash-joined chains of package names describing the
// hoisted install position, e.g. "make-dir/semver" (semver as resolved for
// make-dir). Scoped names keep their own slash: "@scope/pkg/dep".
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

// Entry shape: "key": ["name@version", registry, {dependencies, peerDependencies,
// optionalPeers, ...}, integrity]. Workspace members resolve to "name@workspace:path".
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

// Adapts a bun dependency map ({dependencies, devDependencies, optionalDependencies,
// peerDependencies, optionalPeers: [names]}) to the npm record shape consumed by
// dependencyDeclarations, so declaration kinds and precedence stay identical.
function bunDeclarationRecord(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
    const peerDependenciesMeta = {}
    if (Array.isArray(meta.optionalPeers)) {
        for (const name of meta.optionalPeers) {
            if (typeof name === 'string') peerDependenciesMeta[name] = {optional: true}
        }
    }
    return {
        dependencies: meta.dependencies,
        devDependencies: meta.devDependencies,
        optionalDependencies: meta.optionalDependencies,
        peerDependencies: meta.peerDependencies,
        peerDependenciesMeta,
    }
}

// Mirrors bun resolution: the most specific override key wins ("a/b/name"),
// falling back segment by segment to the hoisted top-level key ("name").
function resolveBunDependency(sourceSegments, name, records) {
    for (let depth = sourceSegments.length; depth >= 0; depth--) {
        const key = [...sourceSegments.slice(0, depth), name].join('/')
        const record = records.get(key)
        if (record) return {key, record}
    }
    return null
}

// bun.lock does not persist npm's per-package dev/optional/peer flags, so they are
// approximated from graph reachability the same way npm derives them: a package is
// dev when unreachable from the root without dev edges, optional (or peer) when
// unreachable without optional (or peer) edges.
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

function parseBunLock(lock, lockfile) {
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
        if (!record) {
            invalidRecords++
            continue
        }
        records.set(key, {...record, segments})
    }
    if (invalidRecords > 0) reasons.push('INVALID_LOCKFILE_PACKAGE_RECORDS')

    // Node ids reuse packageId over the bun install-position key, so ids keep the
    // exact "npm:name@version:hash12" shape the npm parser and sync sanitizer use,
    // and node.name stays the bare package name that hosted BFS grounding matches.
    const externalNodes = new Map()
    let invalidPackageVersions = 0
    for (const [key, record] of records) {
        if (record.workspace) continue
        const version = packageVersion(record.rawVersion)
        if (!version) { invalidPackageVersions++; continue }
        externalNodes.set(key, {
            id: packageId(record.name, version, key),
            name: record.name,
            version,
            direct: false,
            dev: false,
            optional: false,
            peer: false,
        })
    }
    if (invalidPackageVersions > 0) reasons.push('INVALID_LOCKFILE_PACKAGE_VERSIONS')

    const workspaces = lock?.workspaces && typeof lock.workspaces === 'object' && !Array.isArray(lock.workspaces)
        ? lock.workspaces
        : null
    if (!workspaces) reasons.push('BUN_LOCK_WORKSPACES_MISSING')

    // Sources: every workspace member acts as '(root)' (matching how the npm parser
    // treats workspace-local records), then every resolved external package.
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
        if (!node) continue
        sources.push({sourceId: node.id, segments: record.segments, declarationRecord: bunDeclarationRecord(record.meta)})
    }

    const edgeMap = new Map()
    const declarations = emptyDeclarations()
    let declarationLimitReached = false
    outer: for (const source of sources) {
        for (const declaration of dependencyDeclarations(source.declarationRecord)) {
            if (declarations.total >= MAX_DEPENDENCY_DECLARATIONS) {
                declarationLimitReached = true
                break outer
            }
            declarations.total++
            const resolved = resolveBunDependency(source.segments, declaration.name, records)
            if (resolved?.record.workspace) {
                declarations.local++
                continue
            }
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

export function buildPackageDependencyGraph(repoRoot) {
    const boundary = createRepoBoundary(repoRoot)
    if (!boundary.root) return emptyGraph(STATE.ERROR, 'INVALID_REPOSITORY_ROOT')

    let selected = null
    for (const lockfile of LOCKFILES) {
        const resolved = boundary.resolve(lockfile)
        if (resolved.ok) {
            selected = {lockfile, path: resolved.path}
            break
        }
    }
    if (!selected) return emptyGraph(STATE.NOT_APPLICABLE, 'PACKAGE_LOCK_V2_V3_NOT_FOUND')

    try {
        if (statSync(selected.path).size > MAX_LOCKFILE_BYTES) {
            return emptyGraph(STATE.ERROR, 'PACKAGE_LOCK_SIZE_LIMIT_REACHED', {lockfile: selected.lockfile})
        }
        const raw = readFileSync(selected.path, 'utf8')
        if (selected.lockfile === 'bun.lock') return parseBunLock(parseJsonc(raw), selected.lockfile)
        return parseLock(JSON.parse(raw), selected.lockfile)
    } catch {
        return emptyGraph(STATE.ERROR, 'PACKAGE_LOCK_READ_ERROR', {lockfile: selected.lockfile})
    }
}
