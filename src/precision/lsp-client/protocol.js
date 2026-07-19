import {JSON_RPC_VERSION, positiveInteger} from './constants.js'
import {LspProtocolError, LspTimeoutError} from './errors.js'
import {WEAVATRIX_VERSION} from '../../version.js'

export function assertPosition(position) {
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
    const wrapped = new Error(error?.message || 'LSP request failed')
    wrapped.name = 'LspResponseError'
    wrapped.code = error?.code
    wrapped.data = error?.data
    return wrapped
}

export function assertClientWritable(client) {
    if (!['running', 'initialized', 'stopping'].includes(client.state) || client.child.stdin?.destroyed) {
        throw new Error(`LSP client is not writable (state=${client.state})`)
    }
}

export function writeClientMessage(client, message) {
    assertClientWritable(client)
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    if (body.length > client.maxMessageBytes) {
        throw new LspProtocolError(`Outgoing LSP message exceeds ${client.maxMessageBytes} byte limit`)
    }
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
    return new Promise((resolveWrite, rejectWrite) => {
        client.child.stdin.write(
            Buffer.concat([header, body]),
            (error) => error ? rejectWrite(error) : resolveWrite(),
        )
    })
}

export async function requestFromClient(client, method, params = null, {timeoutMs = client.requestTimeoutMs} = {}) {
    if (typeof method !== 'string' || method === '') throw new TypeError('LSP method is required')
    const boundedTimeout = positiveInteger(timeoutMs, client.requestTimeoutMs, 'timeoutMs')
    const id = client.nextId++
    let entry
    const response = new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => {
            if (client.pending.get(id) !== entry) return
            client.pending.delete(id)
            void writeClientMessage(client, {
                jsonrpc: JSON_RPC_VERSION,
                method: '$/cancelRequest',
                params: {id},
            }).catch(() => {})
            rejectResponse(new LspTimeoutError(method, boundedTimeout))
        }, boundedTimeout)
        entry = {method, timer, resolve: resolveResponse, reject: rejectResponse}
        client.pending.set(id, entry)
    })
    try {
        await writeClientMessage(client, {jsonrpc: JSON_RPC_VERSION, id, method, params})
    } catch (error) {
        if (client.pending.get(id) === entry) {
            clearTimeout(entry.timer)
            client.pending.delete(id)
            entry.reject(error)
        }
    }
    return response
}

export async function notifyClient(client, method, params = null) {
    if (typeof method !== 'string' || method === '') throw new TypeError('LSP method is required')
    await writeClientMessage(client, {jsonrpc: JSON_RPC_VERSION, method, params})
}

export async function initializeClient(client, {
    capabilities = {},
    initializationOptions,
    clientInfo = {name: 'weavatrix', version: WEAVATRIX_VERSION},
} = {}) {
    if (client.state !== 'running') throw new Error(`LSP initialize is invalid in state=${client.state}`)
    const workspaceName = client.normalizer.rootPath.split(/[\\/]/).pop() || 'repository'
    const result = await requestFromClient(client, 'initialize', {
        processId: process.pid,
        clientInfo,
        rootUri: client.normalizer.rootUri,
        capabilities,
        initializationOptions,
        workspaceFolders: [{uri: client.normalizer.rootUri, name: workspaceName}],
    })
    await notifyClient(client, 'initialized', {})
    client.state = 'initialized'
    return result
}

export async function openClientDocument(client, {filePath, text, languageId, version = 1}) {
    if (client.state !== 'initialized') throw new Error('LSP client is not initialized')
    if (typeof text !== 'string') throw new TypeError('document text must be a string')
    if (typeof languageId !== 'string' || languageId === '') throw new TypeError('languageId is required')
    if (!Number.isSafeInteger(version) || version < 0) {
        throw new TypeError('document version must be a non-negative integer')
    }
    const normalized = client.normalizer.toUri(filePath)
    await notifyClient(client, 'textDocument/didOpen', {
        textDocument: {uri: normalized.uri, languageId, version, text},
    })
    client.openDocuments.set(normalized.uri, {file: normalized.file, version, languageId})
    return {file: normalized.file, version, languageId}
}

export async function closeClientDocument(client, filePath) {
    const normalized = client.normalizer.toUri(filePath)
    if (!client.openDocuments.has(normalized.uri)) return false
    await notifyClient(client, 'textDocument/didClose', {textDocument: {uri: normalized.uri}})
    client.openDocuments.delete(normalized.uri)
    return true
}

export function normalizeClientLocations(client, result) {
    const locations = []
    for (const raw of result == null ? [] : Array.isArray(result) ? result : [result]) {
        if (raw == null || typeof raw !== 'object') continue
        const uri = raw.uri || raw.targetUri
        const range = raw.range || raw.targetSelectionRange || raw.targetRange
        try {
            const normalized = client.normalizer.fromUri(uri)
            locations.push({file: normalized.file, range: normalizeRange(range)})
        } catch (error) {
            if (error instanceof RangeError) continue
            throw error
        }
    }
    return locations
}

export async function queryClientLocations(client, kind, {filePath, position, includeDeclaration = true, timeoutMs}) {
    const normalized = client.normalizer.toUri(filePath)
    const method = kind === 'references' ? 'textDocument/references' : 'textDocument/definition'
    const params = {textDocument: {uri: normalized.uri}, position: assertPosition(position)}
    if (kind === 'references') params.context = {includeDeclaration: Boolean(includeDeclaration)}
    const result = await requestFromClient(client, method, params, {
        timeoutMs: timeoutMs ?? client.requestTimeoutMs,
    })
    return normalizeClientLocations(client, result)
}

export async function defaultClientServerRequest(client, method, params) {
    if (method === 'workspace/configuration') return Array.isArray(params?.items) ? params.items.map(() => null) : []
    if (method === 'workspace/workspaceFolders') {
        return [{uri: client.normalizer.rootUri, name: client.normalizer.rootPath.split(/[\\/]/).pop() || 'repository'}]
    }
    if (['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create'].includes(method)) return null
    if (method === 'workspace/applyEdit') {
        return {applied: false, failureReason: 'Weavatrix precision provider is read-only'}
    }
    const error = new Error(`Unsupported LSP server request: ${method}`)
    error.code = -32601
    throw error
}

export async function handleClientServerRequest(client, message) {
    try {
        const result = client.onServerRequest
            ? await client.onServerRequest(message.method, message.params, client)
            : await defaultClientServerRequest(client, message.method, message.params)
        await writeClientMessage(client, {jsonrpc: JSON_RPC_VERSION, id: message.id, result: result ?? null})
    } catch (error) {
        try {
            await writeClientMessage(client, {
                jsonrpc: JSON_RPC_VERSION,
                id: message.id,
                error: {
                    code: Number.isInteger(error?.code) ? error.code : -32603,
                    message: error?.message || 'LSP client error',
                },
            })
        } catch { /* process exited while request handler was running */ }
    }
}

export function handleClientMessage(client, message) {
    if (message.jsonrpc !== JSON_RPC_VERSION) throw new LspProtocolError('Unsupported JSON-RPC version from LSP server')
    if (typeof message.method === 'string') {
        if (message.id != null) void handleClientServerRequest(client, message)
        else client.onNotification?.(message.method, message.params, client)
        return
    }
    if (message.id == null) throw new LspProtocolError('LSP response is missing an id')
    const entry = client.pending.get(message.id)
    if (!entry) return
    client.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error != null) entry.reject(jsonRpcError(message.error))
    else entry.resolve(message.result)
}

export function rejectPendingRequests(client, error) {
    for (const entry of client.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
    }
    client.pending.clear()
}
