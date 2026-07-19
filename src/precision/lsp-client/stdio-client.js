import {spawn as spawnChild} from 'node:child_process'
import {isAbsolute} from 'node:path'
import {
    DEFAULT_MAX_HEADER_BYTES,
    DEFAULT_MAX_MESSAGE_BYTES,
    DEFAULT_REQUEST_TIMEOUT_MS,
    positiveInteger,
} from './constants.js'
import {lspChildProcessEnv} from './environment.js'
import {ContentLengthMessageParser} from './message-parser.js'
import {createRepoUriNormalizer} from './repo-uri.js'
import {
    assertLspClientCreationAllowed,
    registerLspClient,
    unregisterLspClient,
} from './registry.js'
import {
    assertClientWritable,
    closeClientDocument,
    defaultClientServerRequest,
    handleClientServerRequest,
    handleClientMessage,
    initializeClient,
    normalizeClientLocations,
    notifyClient,
    openClientDocument,
    queryClientLocations,
    rejectPendingRequests,
    requestFromClient,
    writeClientMessage,
} from './protocol.js'
import {
    failClient,
    killClient,
    killWindowsTreeAndWait,
    shutdownClient,
    shutdownClientOnce,
    waitForClientExit,
} from './lifecycle.js'

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
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
            throw new TypeError('LSP args must be strings')
        }
        if (typeof spawn !== 'function') throw new TypeError('spawn must be a function')
        assertLspClientCreationAllowed()
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
            env: lspChildProcessEnv(env),
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        this.processGroupPid = process.platform !== 'win32' && Number.isInteger(this.child.pid)
            ? this.child.pid : null
        registerLspClient(this)
        this.parser = new ContentLengthMessageParser({
            maxMessageBytes: this.maxMessageBytes,
            maxHeaderBytes,
            onMessage: (message) => this.handleMessage(message),
        })
        this.child.stdout?.on('data', (chunk) => {
            try { this.parser.push(chunk) }
            catch (error) { this.fail(error) }
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
                unregisterLspClient(this)
                resolveExit({code, signal})
            }
            this.child.once('exit', finishExit)
            this.child.once('close', finishExit)
        })
    }

    async start() { await this.spawned; return this }
    assertWritable() { return assertClientWritable(this) }
    writeMessage(message) { return writeClientMessage(this, message) }
    request(method, params, options) { return requestFromClient(this, method, params, options) }
    notify(method, params) { return notifyClient(this, method, params) }
    initialize(options) { return initializeClient(this, options) }
    openDocument(options) { return openClientDocument(this, options) }
    closeDocument(filePath) { return closeClientDocument(this, filePath) }
    normalizeLocations(result) { return normalizeClientLocations(this, result) }
    definition(options) { return queryClientLocations(this, 'definition', options) }
    references(options) { return queryClientLocations(this, 'references', options) }
    defaultServerRequest(method, params) { return defaultClientServerRequest(this, method, params) }
    handleServerRequest(message) { return handleClientServerRequest(this, message) }
    handleMessage(message) { return handleClientMessage(this, message) }
    rejectPending(error) { return rejectPendingRequests(this, error) }
    fail(error) { return failClient(this, error) }
    kill(reason) { return killClient(this, reason) }
    killWindowsTreeAndWait(timeoutMs) { return killWindowsTreeAndWait(this, timeoutMs) }
    waitForExit(timeoutMs) { return waitForClientExit(this, timeoutMs) }
    shutdown(options) { return shutdownClient(this, options) }
    shutdownOnce(options) { return shutdownClientOnce(this, options) }
}

export async function startStdioLspClient(options) {
    const client = new StdioLspClient(options)
    return client.start()
}
