import {spawn as spawnChild} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {delimiter, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {TextDecoder} from 'node:util'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {childProcessEnv} from '../child-env.js'

const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const JSON_RPC_VERSION = '2.0'
const HEADER_DELIMITER = Buffer.from('\r\n\r\n', 'ascii')
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true})
const ACTIVE_LSP_CLIENTS = new Set()
let ACCEPTING_LSP_CLIENTS = true
const LSP_ENV_ALLOWLIST = new Set([
    'path', 'pathext', 'systemroot', 'windir', 'comspec',
    'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'localappdata', 'appdata',
    'lang', 'language', 'lc_all', 'lc_ctype',
])

export function lspChildProcessEnv(overrides = {}) {
    const inherited = childProcessEnv(overrides)
    const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => LSP_ENV_ALLOWLIST.has(key.toLowerCase())))
    const safePath = [dirname(process.execPath)]
    const systemRoot = inherited.SystemRoot || inherited.SYSTEMROOT || inherited.WINDIR
    if (process.platform === 'win32' && systemRoot) safePath.push(join(systemRoot, 'System32'))
    clean.PATH = [...new Set(safePath)].join(delimiter)
    return clean
}

export function activeLspClientCount() {
    return ACTIVE_LSP_CLIENTS.size
}

// A graph build can reach the precision phase after MCP stdin has already closed. Flip this gate
// synchronously at shutdown start so no new TLS/tsserver tree can appear after the active set was
// drained. The MCP process is terminal after this transition, so it is intentionally irreversible.
export function beginLspClientShutdown() {
    ACCEPTING_LSP_CLIENTS = false
}

// MCP disconnects can arrive while an automatic graph refresh is still asking tsserver for
// references. Keep process ownership explicit so the stdio shell can drain or terminate every
// bundled semantic-provider tree before its own process exits.
export async function shutdownActiveLspClients({timeoutMs = 3_000} = {}) {
    const boundedTimeout = Math.max(250, Math.min(10_000, Number(timeoutMs) || 3_000))
    const startedAt = Date.now()
    const clients = [...ACTIVE_LSP_CLIENTS]
    if (!clients.length) return {requested: 0, remaining: 0, timedOut: false}

    let timer
    const gracefulBudget = Math.max(125, Math.floor(boundedTimeout * 0.6))
    const graceful = Promise.allSettled(clients.map((client) => client.shutdown({timeoutMs: boundedTimeout})))
    const outcome = await Promise.race([
        graceful.then(() => 'closed'),
        new Promise((resolveOutcome) => { timer = setTimeout(() => resolveOutcome('timeout'), gracefulBudget) }),
    ])
    if (timer) clearTimeout(timer)

    const survivors = [...ACTIVE_LSP_CLIENTS]
    if (survivors.length) {
        const reason = new Error(`MCP shutdown timed out with ${ACTIVE_LSP_CLIENTS.size} active LSP client(s)`)
        const forceBudget = Math.max(100, boundedTimeout - (Date.now() - startedAt))
        // On Windows, wait for taskkill /T /F itself before exiting the MCP parent. Otherwise the TLS
        // process can die first while its tsserver child keeps the repository directory open.
        await Promise.allSettled(survivors.map(async (client) => {
            if (typeof client.killWindowsTreeAndWait === 'function') {
                await client.killWindowsTreeAndWait(forceBudget)
            }
            client.kill(reason)
            if (typeof client.waitForExit === 'function') await client.waitForExit(Math.max(100, boundedTimeout - (Date.now() - startedAt)))
        }))
    }

    return {
        requested: clients.length,
        remaining: ACTIVE_LSP_CLIENTS.size,
        timedOut: outcome === 'timeout' || ACTIVE_LSP_CLIENTS.size > 0,
    }
}

export class LspProtocolError extends Error {
    constructor(message, options) {
        super(message, options)
        this.name = 'LspProtocolError'
    }
}

export class LspTimeoutError extends Error {
    constructor(method, timeoutMs) {
        super(`LSP request timed out after ${timeoutMs}ms: ${method}`)
        this.name = 'LspTimeoutError'
        this.method = method
        this.timeoutMs = timeoutMs
    }
}

function positiveInteger(value, fallback, label) {
    const candidate = value == null ? fallback : Number(value)
    if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new TypeError(`${label} must be a positive integer`)
    return candidate
}

function asBuffer(chunk) {
    if (Buffer.isBuffer(chunk)) return chunk
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    return Buffer.from(chunk)
}

function parseHeaders(bytes, maxMessageBytes) {
    const text = bytes.toString('ascii')
    const lines = text.split('\r\n')
    let contentLength = null
    for (const line of lines) {
        const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*(.*)$/.exec(line)
        if (!match) throw new LspProtocolError('Malformed LSP header line')
        const name = match[1].toLowerCase()
        if (name !== 'content-length') continue
        if (contentLength != null) throw new LspProtocolError('Duplicate Content-Length header')
        if (!/^(0|[1-9][0-9]*)$/.test(match[2])) throw new LspProtocolError('Invalid Content-Length header')
        contentLength = Number(match[2])
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0) throw new LspProtocolError('Content-Length must be positive')
        if (contentLength > maxMessageBytes) {
            throw new LspProtocolError(`LSP message exceeds ${maxMessageBytes} byte limit`)
        }
    }
    if (contentLength == null) throw new LspProtocolError('Missing Content-Length header')
    return contentLength
}

/** Incremental parser for the Content-Length framed JSON-RPC transport used by LSP. */
export class ContentLengthMessageParser {
    constructor({onMessage, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES, maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES} = {}) {
        if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function')
        this.onMessage = onMessage
        this.maxMessageBytes = positiveInteger(maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 'maxMessageBytes')
        this.maxHeaderBytes = positiveInteger(maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, 'maxHeaderBytes')
        this.buffer = Buffer.alloc(0)
        this.expectedBodyBytes = null
    }

    push(chunk) {
        const incoming = asBuffer(chunk)
        if (incoming.length === 0) return
        this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming])

        while (this.buffer.length > 0) {
            if (this.expectedBodyBytes == null) {
                const delimiterIndex = this.buffer.indexOf(HEADER_DELIMITER)
                if (delimiterIndex < 0) {
                    if (this.buffer.length > this.maxHeaderBytes) throw new LspProtocolError('LSP header exceeds byte limit')
                    return
                }
                if (delimiterIndex === 0) throw new LspProtocolError('Empty LSP header block')
                if (delimiterIndex > this.maxHeaderBytes) throw new LspProtocolError('LSP header exceeds byte limit')
                this.expectedBodyBytes = parseHeaders(this.buffer.subarray(0, delimiterIndex), this.maxMessageBytes)
                this.buffer = this.buffer.subarray(delimiterIndex + HEADER_DELIMITER.length)
            }

            if (this.buffer.length < this.expectedBodyBytes) return
            const body = this.buffer.subarray(0, this.expectedBodyBytes)
            this.buffer = this.buffer.subarray(this.expectedBodyBytes)
            this.expectedBodyBytes = null

            let value
            try {
                value = JSON.parse(UTF8_DECODER.decode(body))
            } catch (error) {
                throw new LspProtocolError('Invalid UTF-8 JSON in LSP message', {cause: error})
            }
            if (value == null || typeof value !== 'object' || Array.isArray(value)) {
                throw new LspProtocolError('LSP message must be a JSON object')
            }
            this.onMessage(value)
        }
    }
}

function normalizeFilesystemPath(path) {
    let normalized = path
    if (process.platform === 'win32' && normalized.startsWith('\\\\?\\UNC\\')) normalized = `\\\\${normalized.slice(8)}`
    else if (process.platform === 'win32' && normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4)
    return resolve(normalized)
}

function realpathIfPossible(path) {
    try {
        return normalizeFilesystemPath(realpathSync.native(path))
    } catch {
        return normalizeFilesystemPath(path)
    }
}

function existingRealpath(path) {
    try {
        return normalizeFilesystemPath(realpathSync.native(path))
    } catch {
        return null
    }
}

function pathInside(rootPath, candidatePath) {
    const rel = relative(rootPath, candidatePath)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function portableRelative(rootPath, candidatePath) {
    return relative(rootPath, candidatePath).split(sep).join('/')
}

/**
 * Creates the only path/URI conversion surface used by the client. Existing symlinks are
 * canonicalized before the repository-boundary check, so an in-repo symlink cannot expose files
 * outside the repository through definition/reference results.
 */
export function createRepoUriNormalizer(repoRoot) {
    if (typeof repoRoot !== 'string' || repoRoot.trim() === '') throw new TypeError('repoRoot is required')
    const lexicalRoot = normalizeFilesystemPath(resolve(repoRoot))
    const absoluteRoot = realpathIfPossible(lexicalRoot)

    const toAbsolute = (filePath) => {
        if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('filePath is required')
        const lexicalPath = normalizeFilesystemPath(resolve(lexicalRoot, filePath))
        const canonicalPath = existingRealpath(lexicalPath)
        if (canonicalPath == null) {
            if (!pathInside(lexicalRoot, lexicalPath)) throw new RangeError('LSP path is outside the repository')
            return lexicalPath
        }
        if (!pathInside(absoluteRoot, canonicalPath)) throw new RangeError('LSP path resolves outside the repository')
        return canonicalPath
    }

    const fromUri = (uri) => {
        if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new RangeError('Only file: LSP URIs are accepted')
        let filePath
        try {
            filePath = fileURLToPath(uri)
        } catch (error) {
            throw new RangeError('Invalid file: LSP URI', {cause: error})
        }
        const absolutePath = toAbsolute(filePath)
        return {file: portableRelative(absoluteRoot, absolutePath), absolutePath, uri: pathToFileURL(absolutePath).href}
    }

    const toUri = (filePath) => {
        const absolutePath = toAbsolute(filePath)
        return {file: portableRelative(absoluteRoot, absolutePath), absolutePath, uri: pathToFileURL(absolutePath).href}
    }

    return {rootPath: absoluteRoot, rootUri: pathToFileURL(absoluteRoot).href, toAbsolute, toUri, fromUri}
}

function assertPosition(position) {
    if (position == null || typeof position !== 'object') throw new TypeError('position is required')
    const line = Number(position.line)
    const character = Number(position.character)
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) {
        throw new TypeError('position line and character must be non-negative integers')
    }
    return {line, character}
}

function normalizeRange(range) {
    if (range == null || typeof range !== 'object') throw new LspProtocolError('LSP location is missing a range')
    return {start: assertPosition(range.start), end: assertPosition(range.end)}
}

function jsonRpcError(error) {
    const message = error?.message || 'LSP request failed'
    const wrapped = new Error(message)
    wrapped.name = 'LspResponseError'
    wrapped.code = error?.code
    wrapped.data = error?.data
    return wrapped
}

function locationArray(result) {
    if (result == null) return []
    return Array.isArray(result) ? result : [result]
}

export class StdioLspClient {
    constructor({
        repoRoot,
        executablePath = process.execPath,
        args = [],
        env = {},
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
        maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
        onNotification,
        onServerRequest,
        spawn = spawnChild,
    } = {}) {
        if (typeof executablePath !== 'string' || !isAbsolute(executablePath)) {
            throw new TypeError('LSP executablePath must be absolute')
        }
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('LSP args must be strings')
        if (typeof spawn !== 'function') throw new TypeError('spawn must be a function')
        if (!ACCEPTING_LSP_CLIENTS) throw new Error('LSP process creation is disabled during MCP shutdown')
        this.normalizer = createRepoUriNormalizer(repoRoot)
        this.requestTimeoutMs = positiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs')
        this.maxMessageBytes = positiveInteger(maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 'maxMessageBytes')
        this.onNotification = typeof onNotification === 'function' ? onNotification : null
        this.onServerRequest = typeof onServerRequest === 'function' ? onServerRequest : null
        this.pending = new Map()
        this.openDocuments = new Map()
        this.nextId = 1
        this.state = 'starting'
        this.stderrTail = ''
        this.shutdownPromise = null

        this.child = spawn(executablePath, args, {
            cwd: this.normalizer.rootPath,
            // The semantic provider needs only OS/process basics. Do not expose package-registry,
            // cloud, hosted-sync, proxy, API-key, NODE_OPTIONS, or arbitrary repo-shell environment.
            env: lspChildProcessEnv(env),
            shell: false,
            // On POSIX, make TLS the leader of a private process group so forced cleanup can also
            // terminate its tsserver child. Piped stdio stays owned by this client; we never unref.
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        this.processGroupPid = process.platform !== 'win32' && Number.isInteger(this.child.pid)
            ? this.child.pid : null
        ACTIVE_LSP_CLIENTS.add(this)
        this.parser = new ContentLengthMessageParser({
            maxMessageBytes: this.maxMessageBytes,
            maxHeaderBytes,
            onMessage: (message) => this.handleMessage(message),
        })
        this.child.stdout?.on('data', (chunk) => {
            try {
                this.parser.push(chunk)
            } catch (error) {
                this.fail(error)
            }
        })
        this.child.stderr?.setEncoding('utf8')
        this.child.stderr?.on('data', (chunk) => {
            this.stderrTail = `${this.stderrTail}${chunk}`.slice(-16_000)
        })
        this.spawned = new Promise((resolveSpawn, rejectSpawn) => {
            this.child.once('spawn', () => {
                if (this.state === 'starting') this.state = 'running'
                resolveSpawn(this)
            })
            this.child.once('error', (error) => {
                this.fail(error)
                rejectSpawn(error)
            })
        })
        this.exited = new Promise((resolveExit) => {
            let settled = false
            const finishExit = (code, signal) => {
                if (settled) return
                settled = true
                const wasStopping = this.state === 'stopping' || this.state === 'closed'
                this.state = 'closed'
                const suffix = this.stderrTail ? `\n${this.stderrTail}` : ''
                this.rejectPending(new Error(`LSP server exited (code=${code}, signal=${signal})${suffix}`))
                if (!wasStopping && code !== 0) this.openDocuments.clear()
                ACTIVE_LSP_CLIENTS.delete(this)
                resolveExit({code, signal})
            }
            // spawn failures emit error + close without an exit event. Listen to both so the process
            // registry cannot retain a client that never started.
            this.child.once('exit', finishExit)
            this.child.once('close', finishExit)
        })
    }

    async start() {
        await this.spawned
        return this
    }

    assertWritable() {
        if (!['running', 'initialized', 'stopping'].includes(this.state) || this.child.stdin?.destroyed) {
            throw new Error(`LSP client is not writable (state=${this.state})`)
        }
    }

    writeMessage(message) {
        this.assertWritable()
        const body = Buffer.from(JSON.stringify(message), 'utf8')
        if (body.length > this.maxMessageBytes) throw new LspProtocolError(`Outgoing LSP message exceeds ${this.maxMessageBytes} byte limit`)
        const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
        return new Promise((resolveWrite, rejectWrite) => {
            this.child.stdin.write(Buffer.concat([header, body]), (error) => error ? rejectWrite(error) : resolveWrite())
        })
    }

    async request(method, params = null, {timeoutMs = this.requestTimeoutMs} = {}) {
        if (typeof method !== 'string' || method === '') throw new TypeError('LSP method is required')
        const boundedTimeout = positiveInteger(timeoutMs, this.requestTimeoutMs, 'timeoutMs')
        const id = this.nextId++
        let entry
        const response = new Promise((resolveResponse, rejectResponse) => {
            const timer = setTimeout(() => {
                if (this.pending.get(id) !== entry) return
                this.pending.delete(id)
                void this.writeMessage({jsonrpc: JSON_RPC_VERSION, method: '$/cancelRequest', params: {id}}).catch(() => {})
                rejectResponse(new LspTimeoutError(method, boundedTimeout))
            }, boundedTimeout)
            entry = {method, timer, resolve: resolveResponse, reject: rejectResponse}
            this.pending.set(id, entry)
        })
        try {
            await this.writeMessage({jsonrpc: JSON_RPC_VERSION, id, method, params})
        } catch (error) {
            if (this.pending.get(id) === entry) {
                clearTimeout(entry.timer)
                this.pending.delete(id)
                entry.reject(error)
            }
        }
        return response
    }

    async notify(method, params = null) {
        if (typeof method !== 'string' || method === '') throw new TypeError('LSP method is required')
        await this.writeMessage({jsonrpc: JSON_RPC_VERSION, method, params})
    }

    async initialize({capabilities = {}, initializationOptions, clientInfo = {name: 'weavatrix', version: '0.2.6'}} = {}) {
        if (this.state !== 'running') throw new Error(`LSP initialize is invalid in state=${this.state}`)
        const result = await this.request('initialize', {
            processId: process.pid,
            clientInfo,
            rootUri: this.normalizer.rootUri,
            capabilities,
            initializationOptions,
            workspaceFolders: [{uri: this.normalizer.rootUri, name: this.normalizer.rootPath.split(/[\\/]/).pop() || 'repository'}],
        })
        await this.notify('initialized', {})
        this.state = 'initialized'
        return result
    }

    async openDocument({filePath, text, languageId, version = 1}) {
        if (this.state !== 'initialized') throw new Error('LSP client is not initialized')
        if (typeof text !== 'string') throw new TypeError('document text must be a string')
        if (typeof languageId !== 'string' || languageId === '') throw new TypeError('languageId is required')
        if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('document version must be a non-negative integer')
        const normalized = this.normalizer.toUri(filePath)
        await this.notify('textDocument/didOpen', {textDocument: {uri: normalized.uri, languageId, version, text}})
        this.openDocuments.set(normalized.uri, {file: normalized.file, version, languageId})
        return {file: normalized.file, version, languageId}
    }

    async closeDocument(filePath) {
        const normalized = this.normalizer.toUri(filePath)
        if (!this.openDocuments.has(normalized.uri)) return false
        await this.notify('textDocument/didClose', {textDocument: {uri: normalized.uri}})
        this.openDocuments.delete(normalized.uri)
        return true
    }

    normalizeLocations(result) {
        const locations = []
        for (const raw of locationArray(result)) {
            if (raw == null || typeof raw !== 'object') continue
            const uri = raw.uri || raw.targetUri
            const range = raw.range || raw.targetSelectionRange || raw.targetRange
            try {
                const normalized = this.normalizer.fromUri(uri)
                locations.push({file: normalized.file, range: normalizeRange(range)})
            } catch (error) {
                if (error instanceof RangeError) continue
                throw error
            }
        }
        return locations
    }

    async definition({filePath, position, timeoutMs}) {
        const normalized = this.normalizer.toUri(filePath)
        const result = await this.request('textDocument/definition', {
            textDocument: {uri: normalized.uri},
            position: assertPosition(position),
        }, {timeoutMs: timeoutMs ?? this.requestTimeoutMs})
        return this.normalizeLocations(result)
    }

    async references({filePath, position, includeDeclaration = true, timeoutMs}) {
        const normalized = this.normalizer.toUri(filePath)
        const result = await this.request('textDocument/references', {
            textDocument: {uri: normalized.uri},
            position: assertPosition(position),
            context: {includeDeclaration: Boolean(includeDeclaration)},
        }, {timeoutMs: timeoutMs ?? this.requestTimeoutMs})
        return this.normalizeLocations(result)
    }

    async defaultServerRequest(method, params) {
        if (method === 'workspace/configuration') {
            return Array.isArray(params?.items) ? params.items.map(() => null) : []
        }
        if (method === 'workspace/workspaceFolders') {
            return [{uri: this.normalizer.rootUri, name: this.normalizer.rootPath.split(/[\\/]/).pop() || 'repository'}]
        }
        if (method === 'client/registerCapability' || method === 'client/unregisterCapability' || method === 'window/workDoneProgress/create') return null
        if (method === 'workspace/applyEdit') return {applied: false, failureReason: 'Weavatrix precision provider is read-only'}
        const error = new Error(`Unsupported LSP server request: ${method}`)
        error.code = -32601
        throw error
    }

    async handleServerRequest(message) {
        try {
            const result = this.onServerRequest
                ? await this.onServerRequest(message.method, message.params, this)
                : await this.defaultServerRequest(message.method, message.params)
            await this.writeMessage({jsonrpc: JSON_RPC_VERSION, id: message.id, result: result ?? null})
        } catch (error) {
            try {
                await this.writeMessage({
                    jsonrpc: JSON_RPC_VERSION,
                    id: message.id,
                    error: {code: Number.isInteger(error?.code) ? error.code : -32603, message: error?.message || 'LSP client error'},
                })
            } catch {
                // The process may have exited while the request handler was running.
            }
        }
    }

    handleMessage(message) {
        if (message.jsonrpc !== JSON_RPC_VERSION) throw new LspProtocolError('Unsupported JSON-RPC version from LSP server')
        if (typeof message.method === 'string') {
            if (message.id != null) void this.handleServerRequest(message)
            else if (this.onNotification) this.onNotification(message.method, message.params, this)
            return
        }
        if (message.id == null) throw new LspProtocolError('LSP response is missing an id')
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error != null) entry.reject(jsonRpcError(message.error))
        else entry.resolve(message.result)
    }

    rejectPending(error) {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer)
            entry.reject(error)
        }
        this.pending.clear()
    }

    fail(error) {
        if (this.state === 'closed' || this.state === 'failed') return
        this.state = 'failed'
        this.rejectPending(error)
        this.kill(error)
    }

    kill(reason = new Error('LSP client was killed')) {
        if (this.state !== 'closed') this.state = 'closed'
        this.rejectPending(reason)
        this.openDocuments.clear()
        try { this.child.stdin?.destroy() } catch { /* already closed */ }
        if (process.platform !== 'win32' && this.processGroupPid) {
            try {
                process.kill(-this.processGroupPid, 'SIGKILL')
                return
            } catch {
                // A custom spawn implementation or an already-reaped group can make group kill
                // unavailable. Fall through to the direct child handle as a bounded fallback.
            }
        }
        if (this.child.exitCode != null || this.child.signalCode != null) return
        if (process.platform === 'win32' && this.child.pid) {
            // typescript-language-server owns a tsserver child. Kill the complete tree on timeout or
            // protocol failure so reconnects never accumulate orphaned semantic providers.
            try {
                const killer = spawnChild('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], {
                    shell: false, windowsHide: true, env: lspChildProcessEnv(), stdio: 'ignore',
                })
                const fallback = () => {
                    try { this.child.kill('SIGKILL') } catch { /* already exited */ }
                }
                killer.once('error', fallback)
                // Sandboxed/locked-down Windows hosts can start taskkill but deny termination. Its
                // non-zero exit must fall back to the direct child handle instead of looking successful.
                killer.once('exit', (code) => { if (code !== 0) fallback() })
            } catch {
                try { this.child.kill('SIGKILL') } catch { /* already exited */ }
            }
        } else {
            try { this.child.kill('SIGKILL') } catch { /* already exited */ }
        }
    }

    async killWindowsTreeAndWait(timeoutMs = 3_000) {
        if (process.platform !== 'win32' || !this.child.pid || this.child.exitCode != null) return
        await new Promise((resolveKill) => {
            let settled = false
            const done = () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolveKill()
            }
            const timer = setTimeout(() => {
                try { this.child.kill() } catch { /* already exited */ }
                done()
            }, Math.max(250, Math.min(5_000, Number(timeoutMs) || 3_000)))
            try {
                const killer = spawnChild('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], {
                    shell: false, windowsHide: true, env: lspChildProcessEnv(), stdio: 'ignore',
                })
                const fallback = () => {
                    try { this.child.kill('SIGKILL') } catch { /* already exited */ }
                }
                killer.once('error', () => { fallback(); done() })
                killer.once('exit', (code) => {
                    if (code !== 0) fallback()
                    done()
                })
            } catch {
                try { this.child.kill('SIGKILL') } catch { /* already exited */ }
                done()
            }
        })
    }

    async waitForExit(timeoutMs = this.requestTimeoutMs) {
        if (!ACTIVE_LSP_CLIENTS.has(this)) return true
        const boundedTimeout = Math.max(100, Math.min(10_000, Number(timeoutMs) || this.requestTimeoutMs))
        let timer
        const outcome = await Promise.race([
            this.exited.then(() => true),
            new Promise((resolveExit) => { timer = setTimeout(() => resolveExit(false), boundedTimeout) }),
        ])
        if (timer) clearTimeout(timer)
        return outcome
    }

    async shutdown(options = {}) {
        if (this.shutdownPromise) return this.shutdownPromise
        this.shutdownPromise = this.shutdownOnce(options)
        return this.shutdownPromise
    }

    async shutdownOnce({timeoutMs = this.requestTimeoutMs} = {}) {
        const boundedTimeout = positiveInteger(timeoutMs, this.requestTimeoutMs, 'timeoutMs')
        try {
            if (this.state === 'starting') await this.spawned
            if (this.state === 'closed') {
                await this.waitForExit(boundedTimeout)
                return
            }
            if (this.state === 'initialized') await this.request('shutdown', null, {timeoutMs: boundedTimeout})
            this.state = 'stopping'
            await this.notify('exit', null)
            // TLS owns a separate tsserver process. On Windows, wait for a whole-tree termination
            // after the protocol shutdown so watched repositories are released before close resolves.
            await this.killWindowsTreeAndWait(Math.min(3_000, boundedTimeout))
            if (process.platform !== 'win32' && this.processGroupPid) {
                // TLS may exit while its tsserver child remains alive. Give the protocol exit a
                // short grace period, then reap the complete private process group unconditionally.
                await this.waitForExit(Math.min(1_000, boundedTimeout))
                try { process.kill(-this.processGroupPid, 'SIGKILL') } catch { /* group already exited */ }
            }
            if (!await this.waitForExit(boundedTimeout)) this.kill(new LspTimeoutError('exit', boundedTimeout))
        } catch (error) {
            this.kill(error)
            await this.killWindowsTreeAndWait(Math.min(2_000, boundedTimeout))
            await this.waitForExit(Math.min(2_000, boundedTimeout))
        }
    }
}

export async function startStdioLspClient(options) {
    const client = new StdioLspClient(options)
    return client.start()
}
