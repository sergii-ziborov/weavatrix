// Global local registry for repository graphs. Absolute paths never leave the machine; composing
// extensions may use the opaque UUID. Identity is anchored in each canonical graph folder so simultaneous MCP
// processes cannot mint different IDs for the same repository.
import {randomUUID} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs'
import {basename, join, relative, resolve} from 'node:path'
import process from 'node:process'
import {graphStorageKey} from './layout.js'
import {atomicWriteFileSync, withFileLockSync} from './file-lock.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MARKER = '.repository-id'

const normalized = (value) => {
    const path = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? path.toLowerCase() : path
}

const realOrResolved = (value) => {
    try { return realpathSync.native(value) } catch { return resolve(value) }
}

const canonicalGraphDir = (repoPath, graphHome) => join(resolve(graphHome), graphStorageKey(repoPath))
const markerPath = (graphDir) => join(graphDir, MARKER)

export function registryPath(graphHome) { return join(graphHome, 'repositories.json') }

export function readRepositoryRegistry(graphHome) {
    try {
        const parsed = JSON.parse(readFileSync(registryPath(graphHome), 'utf8'))
        return parsed?.repositoryRegistryV === 1 && Array.isArray(parsed.repositories)
            ? parsed.repositories.filter((item) => item && typeof item === 'object')
            : []
    } catch { return [] }
}

function writeRegistry(graphHome, repositories) {
    atomicWriteFileSync(registryPath(graphHome), JSON.stringify({repositoryRegistryV: 1, repositories}, null, 2), 'utf8')
}

function readMarker(graphDir) {
    try {
        const id = readFileSync(markerPath(graphDir), 'utf8').trim()
        return UUID.test(id) ? id : null
    } catch { return null }
}

function createOrReadMarker(graphDir, preferredId) {
    mkdirSync(graphDir, {recursive: true})
    const path = markerPath(graphDir)
    const existing = readMarker(graphDir)
    if (existing) return existing
    if (existsSync(path)) throw new Error(`invalid repository identity marker: ${path}`)
    const candidate = UUID.test(String(preferredId || '')) ? preferredId : randomUUID()
    try { writeFileSync(path, `${candidate}\n`, {encoding: 'utf8', flag: 'wx'}) }
    catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const raced = readMarker(graphDir)
        if (!raced) throw new Error(`invalid repository identity marker after concurrent registration: ${path}`)
        return raced
    }
    return candidate
}

export function registerRepository({repoPath, graphDir, graphHome}) {
    mkdirSync(graphHome, {recursive: true})
    const real = realOrResolved(repoPath)
    const canonical = canonicalGraphDir(real, graphHome)
    if (normalized(realOrResolved(graphDir)) !== normalized(realOrResolved(canonical))) {
        throw new Error(`repository graphs must be registered from the canonical graph directory: ${canonical}`)
    }
    return withFileLockSync(join(graphHome, '.repositories.lock'), () => {
        const key = normalized(real)
        const repositories = readRepositoryRegistry(graphHome)
        let record = repositories.find((item) => normalized(item.repoPath) === key)
        const now = new Date().toISOString()
        const repositoryId = createOrReadMarker(canonical, record?.repositoryId)
        if (!record) {
            record = {repositoryId, repoPath: real, label: basename(real) || 'repo', graphDir: canonical, firstSeenAt: now, lastSeenAt: now}
            repositories.push(record)
        } else {
            record.repositoryId = repositoryId
            record.repoPath = real
            record.graphDir = canonical
            record.label = basename(real) || record.label || 'repo'
            record.lastSeenAt = now
        }
        const deduped = repositories.filter((item, index, all) =>
            normalized(item.repoPath) !== key || all.findIndex((candidate) => normalized(candidate.repoPath) === key) === index)
        deduped.sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.repositoryId).localeCompare(String(b.repositoryId)))
        writeRegistry(graphHome, deduped)
        return {...record}
    })
}

export function repositoryRecord(repoPath, graphHome) {
    const real = realOrResolved(repoPath)
    const key = normalized(real)
    return liveRepositoryRecords(graphHome).find((item) => normalized(item.repoPath) === key) || null
}

function validLiveRecord(item, graphHome) {
    if (!UUID.test(String(item?.repositoryId || '')) || typeof item?.repoPath !== 'string' || typeof item?.graphDir !== 'string') return null
    let repoReal
    let graphHomeReal
    let graphReal
    try {
        repoReal = realpathSync.native(item.repoPath)
        graphHomeReal = realpathSync.native(graphHome)
        graphReal = realpathSync.native(item.graphDir)
        if (!statSync(repoReal).isDirectory() || !existsSync(join(repoReal, '.git'))) return null
        if (!statSync(graphReal).isDirectory() || !statSync(join(graphReal, 'graph.json')).isFile()) return null
    } catch { return null }
    if (normalized(graphReal) !== normalized(realOrResolved(canonicalGraphDir(repoReal, graphHomeReal)))) return null
    const rel = relative(graphHomeReal, graphReal)
    if (!rel || rel.startsWith('..') || resolve(graphHomeReal, rel) !== resolve(graphReal)) return null
    if (readMarker(graphReal) !== item.repositoryId) return null
    return {...item, repoPath: repoReal, graphDir: graphReal}
}

export function liveRepositoryRecords(graphHome) {
    if (!existsSync(graphHome)) return []
    return readRepositoryRegistry(graphHome).map((item) => validLiveRecord(item, graphHome)).filter(Boolean)
}
