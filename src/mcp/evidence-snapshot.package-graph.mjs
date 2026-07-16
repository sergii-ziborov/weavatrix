import {createHash} from 'node:crypto'
import {readFileSync, statSync} from 'node:fs'
import {createRepoBoundary} from '../repo-path.js'
import {CAPS, STATE, compareText, safeToken} from './evidence-snapshot.common.mjs'

const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json']
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
        const lock = JSON.parse(readFileSync(selected.path, 'utf8'))
        return parseLock(lock, selected.lockfile)
    } catch {
        return emptyGraph(STATE.ERROR, 'PACKAGE_LOCK_READ_ERROR', {lockfile: selected.lockfile})
    }
}
