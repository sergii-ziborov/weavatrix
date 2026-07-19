import {createHash} from 'node:crypto'
import {existsSync, opendirSync, readFileSync, realpathSync, statSync} from 'node:fs'
import {dirname, isAbsolute, join, relative, resolve} from 'node:path'
import {createRequire} from 'node:module'
import {isPathInside} from '../../repo-path.js'

const requireFromWeavatrix = createRequire(import.meta.url)
const MAX_PROJECT_FILES = 8_192
const MAX_CONFIG_FILES = 128
const MAX_CONFIG_BYTES = 8 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 32_768
const MAX_DIRECTORIES = 4_096
const DEFAULT_SAFETY_TIMEOUT_MS = 5_000
export const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')

export function canonicalKey(path, caseSensitive) {
    let canonical
    try { canonical = realpathSync.native(path) } catch { return null }
    return caseSensitive ? canonical : canonical.toLowerCase()
}

export function typeScriptRepoContext(repoRoot) {
    let root
    let ts
    try {
        root = realpathSync.native(repoRoot)
        ts = requireFromWeavatrix('typescript')
    } catch { return null }
    return {root, ts, caseSensitive: Boolean(ts.sys.useCaseSensitiveFileNames)}
}

export function guardedExistingPath(root, candidate, state = null) {
    const input = String(candidate || '')
    const lexical = isAbsolute(input) ? resolve(input) : resolve(root, input)
    if (!isPathInside(root, lexical)) {
        if (state) state.outsideAccess = true
        return null
    }
    try {
        const canonical = realpathSync.native(lexical)
        if (!isPathInside(root, canonical)) {
            if (state) state.outsideAccess = true
            return null
        }
        return canonical
    } catch { return null }
}

export function nearestTypeScriptConfig(context, absoluteFile) {
    const {root} = context
    let directory = dirname(absoluteFile)
    while (isPathInside(root, directory)) {
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const candidate = join(directory, name)
            if (!existsSync(candidate)) continue
            const configPath = guardedExistingPath(root, candidate)
            return configPath ? {ok: true, configPath} : {ok: false, reason: 'CONFIG_OUTSIDE_REPOSITORY'}
        }
        if (directory === root) break
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
    }
    return {ok: true, configPath: null}
}

export function safetyBudget(options = {}) {
    const requestedDeadline = Number(options.deadline)
    const requestedTimeout = Number(options.timeoutMs)
    const timeout = Number.isFinite(requestedTimeout)
        ? Math.max(100, Math.min(60_000, Math.floor(requestedTimeout)))
        : DEFAULT_SAFETY_TIMEOUT_MS
    return {
        deadline: Number.isFinite(requestedDeadline) ? requestedDeadline : Date.now() + timeout,
        maxEntries: Math.max(1, Math.min(MAX_DIRECTORY_ENTRIES,
            Number.isFinite(Number(options.maxDirectoryEntries))
                ? Math.floor(Number(options.maxDirectoryEntries)) : MAX_DIRECTORY_ENTRIES)),
        maxDirectories: Math.max(1, Math.min(MAX_DIRECTORIES,
            Number.isFinite(Number(options.maxDirectories))
                ? Math.floor(Number(options.maxDirectories)) : MAX_DIRECTORIES)),
        entries: 0,
        directories: 0,
        configBytes: 0,
        configFiles: new Set(),
        reason: null,
    }
}

function safetyLimitReached(budget, reason = 'PROJECT_INPUT_LIMIT') {
    if (!budget.reason && Date.now() >= budget.deadline) budget.reason = 'SAFETY_DEADLINE'
    if (!budget.reason && reason) budget.reason = reason
    return Boolean(budget.reason)
}

function boundedReadDirectory(context, state, budget, candidate, extensions, excludes, includes, depth) {
    const {root, ts, caseSensitive} = context
    const path = guardedExistingPath(root, candidate, state)
    if (!path || safetyLimitReached(budget, null)) return []
    const getFileSystemEntries = (directoryPath) => {
        if (safetyLimitReached(budget, null)) return {files: [], directories: []}
        const directory = guardedExistingPath(root, directoryPath, state)
        if (!directory) return {files: [], directories: []}
        budget.directories++
        if (budget.directories > budget.maxDirectories) {
            safetyLimitReached(budget)
            return {files: [], directories: []}
        }
        const files = []
        const directories = []
        let handle
        try {
            handle = opendirSync(directory)
            while (!safetyLimitReached(budget, null)) {
                const entry = handle.readSync()
                if (!entry) break
                budget.entries++
                if (budget.entries > budget.maxEntries) {
                    safetyLimitReached(budget)
                    break
                }
                if (entry.isFile()) files.push(entry.name)
                else if (entry.isDirectory()) directories.push(entry.name)
                else if (entry.isSymbolicLink()) {
                    const linked = guardedExistingPath(root, join(directory, entry.name), state)
                    if (!linked) continue
                    let stats
                    try { stats = statSync(linked) } catch { continue }
                    if (stats.isFile()) files.push(entry.name)
                    else if (stats.isDirectory()) directories.push(entry.name)
                }
            }
        } catch {
            return {files: [], directories: []}
        } finally {
            try { handle?.closeSync() } catch {}
        }
        return {files, directories}
    }
    const guardedRealpath = (entry) => guardedExistingPath(root, entry, state)
        || resolve(root, '.weavatrix-invalid-path')
    try {
        return ts.matchFiles(
            path, extensions, excludes, includes, caseSensitive, root, depth,
            getFileSystemEntries, guardedRealpath,
        )
    } catch {
        state.limitExceeded = true
        return []
    }
}

export function parseRepoConfig(context, configPath, budget) {
    const {root, ts, caseSensitive} = context
    const state = {
        outsideAccess: false,
        limitExceeded: false,
        configuredPlugins: false,
        bytes: 0,
        records: new Map(),
    }
    const diagnostics = []
    const host = {
        useCaseSensitiveFileNames: caseSensitive,
        getCurrentDirectory: () => root,
        fileExists(candidate) {
            const path = guardedExistingPath(root, candidate, state)
            return Boolean(path && ts.sys.fileExists(path))
        },
        readFile(candidate) {
            if (safetyLimitReached(budget, null)) return undefined
            const path = guardedExistingPath(root, candidate, state)
            if (!path) return undefined
            let body
            try {
                const size = statSync(path).size
                if (size > MAX_CONFIG_BYTES || state.bytes + size > MAX_CONFIG_BYTES) {
                    state.limitExceeded = true
                    return undefined
                }
                body = readFileSync(path)
            } catch { return undefined }
            const rel = norm(relative(root, path))
            if (!state.records.has(rel)) {
                if (!budget.configFiles.has(rel)
                    && (budget.configFiles.size >= MAX_CONFIG_FILES
                        || budget.configBytes + body.byteLength > MAX_CONFIG_BYTES)) {
                    state.limitExceeded = true
                    safetyLimitReached(budget, 'CONFIG_INPUT_LIMIT')
                    return undefined
                }
                if (!budget.configFiles.has(rel)) {
                    budget.configFiles.add(rel)
                    budget.configBytes += body.byteLength
                }
                state.records.set(rel, createHash('sha256').update(body).digest('hex'))
                state.bytes += body.byteLength
            }
            try {
                const raw = ts.parseConfigFileTextToJson(path, body.toString('utf8')).config
                if (Array.isArray(raw?.compilerOptions?.plugins) && raw.compilerOptions.plugins.length) {
                    state.configuredPlugins = true
                }
            } catch { /* parser diagnostics below decide safety */ }
            return body.toString('utf8')
        },
        readDirectory(candidate, extensions, excludes, includes, depth) {
            return boundedReadDirectory(context, state, budget, candidate, extensions, excludes, includes, depth)
        },
        onUnRecoverableConfigFileDiagnostic(diagnostic) { diagnostics.push(diagnostic) },
        trace() {},
    }
    let parsed
    try { parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host) }
    catch { return {complete: false, reason: 'CONFIG_PARSE_FAILED'} }
    const errors = [...diagnostics, ...(parsed?.errors || [])]
    if (state.configuredPlugins || (Array.isArray(parsed?.options?.plugins) && parsed.options.plugins.length)) {
        return {complete: false, reason: 'CONFIGURED_TSSERVER_PLUGINS'}
    }
    if (budget.reason) return {complete: false, reason: budget.reason}
    if (!parsed || state.outsideAccess || state.limitExceeded
        || errors.some((diagnostic) => diagnostic?.category === ts.DiagnosticCategory.Error)) {
        return {
            complete: false,
            reason: state.outsideAccess
                ? 'CONFIG_OUTSIDE_REPOSITORY'
                : state.limitExceeded ? 'CONFIG_INPUT_LIMIT' : 'CONFIG_PARSE_FAILED',
        }
    }
    const projectFiles = []
    const projectKeys = new Set()
    for (const file of parsed.fileNames) {
        const canonical = guardedExistingPath(root, file, state)
        if (!canonical) return {complete: false, reason: 'PROJECT_INPUT_OUTSIDE_REPOSITORY'}
        const key = caseSensitive ? canonical : canonical.toLowerCase()
        if (projectKeys.has(key)) continue
        projectKeys.add(key)
        projectFiles.push(norm(relative(root, canonical)))
        if (projectFiles.length > MAX_PROJECT_FILES) return {complete: false, reason: 'PROJECT_INPUT_LIMIT'}
    }
    projectFiles.sort()
    return {
        complete: true,
        parsed,
        projectFiles,
        projectKeys,
        configRecords: state.records,
        plugins: [],
    }
}
