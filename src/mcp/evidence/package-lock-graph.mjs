import {compareText, STATE} from '../evidence-snapshot.common.mjs'
import {
    MAX_DEPENDENCY_DECLARATIONS, MAX_PACKAGE_RECORDS, dependencyDeclarations,
    emptyDeclarations, emptyGraph, finalizeGraph, normalizeLockPath, packageId,
    packageNameFromPath, packageVersion, parentInstallPath,
} from './package-graph-common.mjs'

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

export function parsePackageLock(lock, lockfile) {
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
        if (packagePath == null || !record || typeof record !== 'object' || Array.isArray(record) ||
            ((packagePath.startsWith('node_modules/') || packagePath.includes('/node_modules/')) && !packageNameFromPath(packagePath)) || records.has(packagePath)) {
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
            id: packageId(name, version, packagePath), name, version, direct: false,
            dev: record.dev === true || record.devOptional === true,
            optional: record.optional === true || record.devOptional === true,
            peer: record.peer === true,
        })
    }
    if (invalidPackageVersions > 0) reasons.push('INVALID_LOCKFILE_PACKAGE_VERSIONS')
    const edgeMap = new Map()
    const declarations = emptyDeclarations()
    let declarationLimitReached = false
    const sources = [...records].filter(([packagePath]) => packageNameFromPath(packagePath) == null || externalNodes.has(packagePath))
        .sort(([a], [b]) => compareText(a, b))
    outer: for (const [sourcePath, record] of sources) {
        const sourceNode = externalNodes.get(sourcePath)
        const sourceId = sourceNode?.id || '(root)'
        for (const declaration of dependencyDeclarations(record)) {
            if (declarations.total >= MAX_DEPENDENCY_DECLARATIONS) { declarationLimitReached = true; break outer }
            declarations.total++
            const resolved = resolveDependency(sourcePath, declaration.name, records, externalNodes)
            if (resolved.kind === 'local') { declarations.local++; continue }
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
