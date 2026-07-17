import {createHash} from 'node:crypto'
import {existsSync, opendirSync, readFileSync, realpathSync, statSync} from 'node:fs'
import {dirname, extname, isAbsolute, join, relative, resolve} from 'node:path'
import {createRequire} from 'node:module'
import {startStdioLspClient} from './lsp-client.js'
import {isPathInside} from '../repo-path.js'

const requireFromWeavatrix = createRequire(import.meta.url)
const PROVIDER = 'typescript-language-server'
export const TYPESCRIPT_LSP_CAPABILITY_CONTRACT = 'typescript-references-v3'
const WEAVATRIX_VERSION = String(requireFromWeavatrix('../../package.json').version || 'unknown')
const MAX_PROJECT_FILES = 8_192
const MAX_CONFIG_FILES = 128
const MAX_CONFIG_BYTES = 8 * 1024 * 1024
const MAX_EXTRA_INPUT_BYTES = 64 * 1024 * 1024
const MAX_PROJECT_INPUT_BYTES = 128 * 1024 * 1024
const MAX_SINGLE_INPUT_BYTES = 4 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 32_768
const MAX_DIRECTORIES = 4_096
const DEFAULT_SAFETY_TIMEOUT_MS = 5_000
const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')

let discoveredProvider = null

function resolveOwn(specifier) {
    const resolved = requireFromWeavatrix.resolve(specifier)
    if (!isAbsolute(resolved)) throw new Error(`Resolved dependency path is not absolute: ${specifier}`)
    return realpathSync.native(resolved)
}

function packageInfoFrom(startPath, expectedName) {
    let directory = dirname(startPath)
    for (let depth = 0; depth < 10; depth++) {
        const packagePath = join(directory, 'package.json')
        if (existsSync(packagePath)) {
            try {
                const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
                if (manifest.name === expectedName) return {directory, manifest, packagePath: realpathSync.native(packagePath)}
            } catch {
                // Continue upward; this may be an unrelated or malformed nested package.
            }
        }
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
    }
    throw new Error(`Could not locate ${expectedName} package metadata`)
}

function resolveServerCli() {
    const candidates = [
        'typescript-language-server',
        'typescript-language-server/lib/cli.mjs',
        'typescript-language-server/lib/cli.js',
    ]
    let lastError
    for (const candidate of candidates) {
        try {
            const path = resolveOwn(candidate)
            if (existsSync(path)) return path
        } catch (error) {
            lastError = error
        }
    }
    throw lastError || new Error('typescript-language-server CLI was not found')
}

function resolveTypeScriptServer() {
    const candidates = ['typescript/lib/tsserver.js', 'typescript/lib/_tsserver.js']
    let lastError
    for (const candidate of candidates) {
        try {
            const path = resolveOwn(candidate)
            if (existsSync(path)) return path
        } catch (error) {
            lastError = error
        }
    }
    try {
        const typescriptEntry = resolveOwn('typescript')
        for (const name of ['tsserver.js', '_tsserver.js']) {
            const candidate = join(dirname(typescriptEntry), name)
            if (existsSync(candidate)) return realpathSync.native(candidate)
        }
    } catch (error) {
        lastError = error
    }
    throw lastError || new Error('Bundled TypeScript tsserver was not found')
}

function discover() {
    if (discoveredProvider) return discoveredProvider
    const cliPath = resolveServerCli()
    const tsserverPath = resolveTypeScriptServer()
    const serverPackage = packageInfoFrom(cliPath, PROVIDER)
    const typescriptPackage = packageInfoFrom(tsserverPath, 'typescript')
    discoveredProvider = Object.freeze({
        available: true,
        provider: PROVIDER,
        version: String(serverPackage.manifest.version || 'unknown'),
        typescriptVersion: String(typescriptPackage.manifest.version || 'unknown'),
        cliPath,
        tsserverPath,
    })
    return discoveredProvider
}

export function typeScriptLspContract() {
    const availability = typeScriptLspAvailability()
    return [
        TYPESCRIPT_LSP_CAPABILITY_CONTRACT,
        `${PROVIDER}@${availability.version || 'unavailable'}`,
        `typescript@${availability.typescriptVersion || 'unavailable'}`,
        `runtime@${process.platform}-${process.arch}-node${String(process.versions.node || '0').split('.')[0]}`,
    ].join('|')
}

export function typeScriptLspAvailability() {
    try {
        const result = discover()
        return {
            available: true,
            provider: result.provider,
            version: result.version,
            typescriptVersion: result.typescriptVersion,
        }
    } catch (error) {
        return {
            available: false,
            provider: PROVIDER,
            version: null,
            typescriptVersion: null,
            reason: error?.code === 'MODULE_NOT_FOUND' ? 'DEPENDENCY_NOT_INSTALLED' : 'DISCOVERY_FAILED',
        }
    }
}

export function typeScriptLanguageId(filePath) {
    const extension = extname(String(filePath)).toLowerCase()
    if (extension === '.ts' || extension === '.mts' || extension === '.cts') return 'typescript'
    if (extension === '.tsx') return 'typescriptreact'
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'javascript'
    if (extension === '.jsx') return 'javascriptreact'
    return null
}

function typeScriptScriptKind(ts, filePath) {
    const extension = extname(String(filePath)).toLowerCase()
    if (extension === '.tsx') return ts.ScriptKind.TSX
    if (extension === '.jsx') return ts.ScriptKind.JSX
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
    return ts.ScriptKind.TS
}

// Classify an exact LSP reference without consulting repository dependencies or executing project
// configuration. Unknown is deliberately fail-closed: callers must not promote it to runtime.
export function classifyTypeScriptReferenceUsage(filePath, text, position) {
    if (!Number.isInteger(position?.line) || !Number.isInteger(position?.character)) return 'unknown'
    let ts
    try { ts = requireFromWeavatrix('typescript') } catch { return 'unknown' }
    let sourceFile
    let offset
    try {
        sourceFile = ts.createSourceFile(
            String(filePath || 'source.ts'),
            String(text || ''),
            ts.ScriptTarget.Latest,
            true,
            typeScriptScriptKind(ts, filePath),
        )
        if (sourceFile.parseDiagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
            return 'unknown'
        }
        offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character)
    } catch {
        return 'unknown'
    }
    let token
    try { token = ts.getTokenAtPosition(sourceFile, offset) } catch { return 'unknown' }
    if (!token || (!ts.isIdentifier(token) && !ts.isPrivateIdentifier(token))) return 'unknown'
    if (offset < token.getStart(sourceFile) || offset >= token.getEnd()) return 'unknown'

    for (let current = token; current && current !== sourceFile; current = current.parent) {
        if ((ts.isImportSpecifier(current) || ts.isImportClause(current)
            || ts.isExportSpecifier(current) || ts.isExportDeclaration(current))
            && current.isTypeOnly === true) return 'type'

        // TypeScript models both class `extends` and `implements` as a type node. The base
        // expression of a class extends clause is evaluated at runtime; implements, interface
        // heritage, and generic arguments remain type-only.
        if (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent)) {
            const heritage = current.parent
            if (heritage.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(heritage.parent)) {
                const expression = current.expression
                if (offset >= expression.getStart(sourceFile) && offset < expression.getEnd()) return 'value'
            }
            return 'type'
        }
        if (ts.isTypeNode(current)) return 'type'
    }
    return 'value'
}

function canonicalKey(path, caseSensitive) {
    let canonical
    try { canonical = realpathSync.native(path) } catch { return null }
    return caseSensitive ? canonical : canonical.toLowerCase()
}

function typeScriptRepoContext(repoRoot) {
    let root
    let ts
    try {
        root = realpathSync.native(repoRoot)
        ts = requireFromWeavatrix('typescript')
    } catch {
        return null
    }
    return {root, ts, caseSensitive: Boolean(ts.sys.useCaseSensitiveFileNames)}
}

function guardedExistingPath(root, candidate, state = null) {
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
    } catch {
        return null
    }
}

function nearestTypeScriptConfig(context, absoluteFile) {
    const {root} = context
    let directory = dirname(absoluteFile)
    while (isPathInside(root, directory)) {
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const candidate = join(directory, name)
            if (!existsSync(candidate)) continue
            const configPath = guardedExistingPath(root, candidate)
            return configPath
                ? {ok: true, configPath}
                : {ok: false, reason: 'CONFIG_OUTSIDE_REPOSITORY'}
        }
        if (directory === root) break
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
    }
    return {ok: true, configPath: null}
}

function safetyBudget(options = {}) {
    const requestedDeadline = Number(options.deadline)
    const requestedTimeout = Number(options.timeoutMs)
    const timeout = Number.isFinite(requestedTimeout)
        ? Math.max(100, Math.min(60_000, Math.floor(requestedTimeout)))
        : DEFAULT_SAFETY_TIMEOUT_MS
    return {
        deadline: Number.isFinite(requestedDeadline) ? requestedDeadline : Date.now() + timeout,
        maxEntries: Math.max(1, Math.min(MAX_DIRECTORY_ENTRIES,
            Number.isFinite(Number(options.maxDirectoryEntries)) ? Math.floor(Number(options.maxDirectoryEntries)) : MAX_DIRECTORY_ENTRIES)),
        maxDirectories: Math.max(1, Math.min(MAX_DIRECTORIES,
            Number.isFinite(Number(options.maxDirectories)) ? Math.floor(Number(options.maxDirectories)) : MAX_DIRECTORIES)),
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
                    // Follow only links whose canonical target remains inside the repository. The
                    // matcher also receives a guarded realpath callback to prevent cycles.
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
    const guardedRealpath = (entry) => guardedExistingPath(root, entry, state) || resolve(root, '.weavatrix-invalid-path')
    try {
        return ts.matchFiles(
            path,
            extensions,
            excludes,
            includes,
            caseSensitive,
            root,
            depth,
            getFileSystemEntries,
            guardedRealpath,
        )
    } catch {
        state.limitExceeded = true
        return []
    }
}

function parseRepoConfig(context, configPath, budget) {
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
            } catch {
                return undefined
            }
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
            // TypeScript currently merges compilerOptions.plugins, but audit every config body it
            // reads as well. This keeps the pre-spawn guard fail-closed across TypeScript versions
            // and catches plugins hidden in an extends chain before tsserver can see the project.
            try {
                const raw = ts.parseConfigFileTextToJson(path, body.toString('utf8')).config
                if (Array.isArray(raw?.compilerOptions?.plugins) && raw.compilerOptions.plugins.length) {
                    state.configuredPlugins = true
                }
            } catch {
                // The parser's diagnostics below decide whether malformed configuration is safe.
            }
            return body.toString('utf8')
        },
        readDirectory(candidate, extensions, excludes, includes, depth) {
            return boundedReadDirectory(context, state, budget, candidate, extensions, excludes, includes, depth)
        },
        onUnRecoverableConfigFileDiagnostic(diagnostic) { diagnostics.push(diagnostic) },
        trace() {},
    }
    let parsed
    try { parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host) } catch {
        return {complete: false, reason: 'CONFIG_PARSE_FAILED'}
    }
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

function referenceConfigPath(context, reference) {
    const {root, ts} = context
    let candidate
    try {
        candidate = typeof ts.resolveProjectReferencePath === 'function'
            ? ts.resolveProjectReferencePath(reference)
            : reference?.path
    } catch {
        return null
    }
    if (!candidate) return null
    return guardedExistingPath(root, candidate)
}

// This audit runs before spawning tsserver. It uses only bundled TypeScript and a repo-contained
// config host, rejects every configured plugin, recursively inspects project references, and binds
// ignored config/project inputs into a bounded digest for cache and post-LSP freshness checks.
export function typeScriptProjectSafety(repoRoot, relFiles = [], options = {}) {
    const context = typeScriptRepoContext(repoRoot)
    if (!context) return {safe: false, reason: 'TYPESCRIPT_UNAVAILABLE', fingerprint: null}
    const {root} = context
    const budget = safetyBudget(options)
    const files = [...new Set((relFiles || []).map(norm).filter(Boolean))].sort()
    if (files.length > MAX_PROJECT_FILES) return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
    const graphFiles = new Set(files)
    const mappings = []
    const fileConfigs = {}
    const queue = []
    const queued = new Set()
    for (const file of files) {
        const absolute = guardedExistingPath(root, file)
        if (!absolute) return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
        const nearest = nearestTypeScriptConfig(context, absolute)
        if (!nearest.ok) return {safe: false, reason: nearest.reason, fingerprint: null}
        const configRel = nearest.configPath ? norm(relative(root, nearest.configPath)) : '<inferred>'
        mappings.push(`${file}=>${configRel}`)
        fileConfigs[file] = nearest.configPath ? configRel : null
        if (nearest.configPath && !queued.has(nearest.configPath)) {
            queued.add(nearest.configPath)
            queue.push(nearest.configPath)
        }
    }

    const configRecords = new Map()
    const projectFiles = new Set()
    const projects = {}
    for (let cursor = 0; cursor < queue.length; cursor++) {
        if (safetyLimitReached(budget, null)) return {safe: false, reason: budget.reason, fingerprint: null}
        if (queue.length > MAX_CONFIG_FILES) return {safe: false, reason: 'CONFIG_INPUT_LIMIT', fingerprint: null}
        const configPath = queue[cursor]
        const parsed = parseRepoConfig(context, configPath, budget)
        if (!parsed.complete) return {safe: false, reason: parsed.reason, fingerprint: null}
        const configRel = norm(relative(root, configPath))
        projects[configRel] = {
            projectFiles: parsed.projectFiles,
            configFiles: [...parsed.configRecords.keys()].sort(),
        }
        for (const [file, digest] of parsed.configRecords) {
            configRecords.set(file, digest)
            if (configRecords.size > MAX_CONFIG_FILES) return {safe: false, reason: 'CONFIG_INPUT_LIMIT', fingerprint: null}
        }
        for (const file of parsed.projectFiles) {
            projectFiles.add(file)
            if (projectFiles.size > MAX_PROJECT_FILES) return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
        }
        for (const reference of parsed.parsed.projectReferences || []) {
            const referenced = referenceConfigPath(context, reference)
            if (!referenced) return {safe: false, reason: 'PROJECT_REFERENCE_UNRESOLVED', fingerprint: null}
            if (!queued.has(referenced)) {
                queued.add(referenced)
                queue.push(referenced)
            }
        }
    }

    const extraRecords = []
    let projectBytes = 0
    let extraBytes = 0
    for (const file of [...projectFiles].sort()) {
        if (safetyLimitReached(budget, null)) return {safe: false, reason: budget.reason, fingerprint: null}
        const absolute = guardedExistingPath(root, file)
        if (!absolute) return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
        let size
        try {
            const stats = statSync(absolute)
            if (!stats.isFile()) return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
            size = stats.size
            if (size > MAX_SINGLE_INPUT_BYTES || projectBytes + size > MAX_PROJECT_INPUT_BYTES) {
                return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
            }
        } catch {
            return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
        }
        projectBytes += size
        if (graphFiles.has(file)) continue
        if (extraBytes + size > MAX_EXTRA_INPUT_BYTES) {
            return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
        }
        let body
        try { body = readFileSync(absolute) } catch {
            return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
        }
        extraBytes += body.byteLength
        extraRecords.push(`${file}:${createHash('sha256').update(body).digest('hex')}`)
    }
    const fingerprint = createHash('sha256').update([
        ...mappings.map((item) => `map:${item}`),
        ...[...configRecords.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, digest]) => `config:${file}:${digest}`),
        ...[...projectFiles].sort().map((file) => `project:${file}`),
        ...extraRecords.map((item) => `extra:${item}`),
    ].join('\n')).digest('hex')
    return {
        safe: true,
        reason: null,
        fingerprint,
        configFiles: [...configRecords.keys()].sort(),
        projectFiles: [...projectFiles].sort(),
        fileConfigs,
        projects,
    }
}

// An empty references response is useful dead-code evidence only when TypeScript itself confirms
// that the declaration belongs to a complete configured project. Merely finding an ancestor
// tsconfig is not enough: include/exclude/files can leave the target in an inferred project.
export function typeScriptConfiguredProjectMembership(repoRoot, relFile) {
    const context = typeScriptRepoContext(repoRoot)
    if (!context) return {complete: false, member: false, reason: 'TYPESCRIPT_UNAVAILABLE'}
    const {root, caseSensitive} = context
    const target = guardedExistingPath(root, relFile)
    if (!target) {
        return {complete: false, member: false, reason: 'UNREADABLE_PATH'}
    }
    const nearest = nearestTypeScriptConfig(context, target)
    if (!nearest.ok) return {complete: false, member: false, reason: nearest.reason}
    const configPath = nearest.configPath
    if (!configPath) return {complete: false, member: false, reason: 'NO_CONFIGURED_PROJECT'}
    const parsed = parseRepoConfig(context, configPath, safetyBudget())
    if (!parsed.complete) return {complete: false, member: false, reason: parsed.reason}
    const targetKey = canonicalKey(target, caseSensitive)
    const member = parsed.projectKeys.has(targetKey)
    return {
        complete: true,
        member,
        projectFiles: parsed.projectFiles,
        configFiles: [...parsed.configRecords.keys()].sort(),
        configFile: norm(relative(root, configPath)),
        reason: member ? null : 'NOT_IN_CONFIGURED_PROJECT',
    }
}

/**
 * Starts Weavatrix's own bundled TypeScript language server. Resolution is anchored to this
 * module, never to the repository being analyzed; no repository command, package script, or npx
 * executable is invoked.
 */
export async function createTypeScriptLspClient({repoRoot, timeoutMs = 10_000} = {}) {
    const discovered = discover()
    const absoluteRepoRoot = resolve(repoRoot)
    let client
    let reportedTypeScript = null
    try {
        client = await startStdioLspClient({
            repoRoot: absoluteRepoRoot,
            executablePath: process.execPath,
            args: [discovered.cliPath, '--stdio'],
            requestTimeoutMs: timeoutMs,
            onNotification(method, params) {
                if (method === '$/typescriptVersion' && params && typeof params === 'object') {
                    reportedTypeScript = {
                        version: typeof params.version === 'string' ? params.version : null,
                        source: typeof params.source === 'string' ? params.source : null,
                    }
                }
            },
        })
        await client.initialize({
            clientInfo: {name: 'weavatrix', version: WEAVATRIX_VERSION},
            capabilities: {
                workspace: {configuration: true, workspaceFolders: true},
                textDocument: {
                    definition: {linkSupport: true},
                    references: {},
                    publishDiagnostics: {relatedInformation: false},
                },
            },
            initializationOptions: {
                hostInfo: 'weavatrix',
                disableAutomaticTypingAcquisition: true,
                tsserver: {path: discovered.tsserverPath},
            },
        })
    } catch (error) {
        client?.kill(error)
        throw error
    }

    return Object.freeze({
        provider: discovered.provider,
        version: discovered.version,
        providerContract: typeScriptLspContract(),
        get typescriptVersion() { return reportedTypeScript?.version || discovered.typescriptVersion },
        get typescriptSource() { return reportedTypeScript?.source || 'configured-bundled-path' },
        async openDocument(relPath, text, languageId = typeScriptLanguageId(relPath)) {
            if (!languageId) throw new TypeError(`Unsupported TypeScript LSP document extension: ${relPath}`)
            return client.openDocument({filePath: relPath, text, languageId})
        },
        references(relPath, position, includeDeclaration = true, referenceTimeoutMs = timeoutMs) {
            return client.references({filePath: relPath, position, includeDeclaration, timeoutMs: referenceTimeoutMs})
        },
        definition(relPath, position) {
            return client.definition({filePath: relPath, position})
        },
        closeDocument(relPath) {
            return client.closeDocument(relPath)
        },
        close(shutdownTimeoutMs = timeoutMs) {
            return client.shutdown({timeoutMs: shutdownTimeoutMs})
        },
        kill() {
            client.kill()
        },
    })
}
