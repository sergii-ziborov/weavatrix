import {TextDecoder} from 'node:util'
import {DEFAULT_MAX_HEADER_BYTES, DEFAULT_MAX_MESSAGE_BYTES, positiveInteger} from './constants.js'
import {LspProtocolError} from './errors.js'

const HEADER_DELIMITER = Buffer.from('\r\n\r\n', 'ascii')
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true})

function asBuffer(chunk) {
    if (Buffer.isBuffer(chunk)) return chunk
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    return Buffer.from(chunk)
}

function parseHeaders(bytes, maxMessageBytes) {
    const lines = bytes.toString('ascii').split('\r\n')
    let contentLength = null
    for (const line of lines) {
        const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*(.*)$/.exec(line)
        if (!match) throw new LspProtocolError('Malformed LSP header line')
        if (match[1].toLowerCase() !== 'content-length') continue
        if (contentLength != null) throw new LspProtocolError('Duplicate Content-Length header')
        if (!/^(0|[1-9][0-9]*)$/.test(match[2])) throw new LspProtocolError('Invalid Content-Length header')
        contentLength = Number(match[2])
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
            throw new LspProtocolError('Content-Length must be positive')
        }
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
                this.expectedBodyBytes = parseHeaders(
                    this.buffer.subarray(0, delimiterIndex),
                    this.maxMessageBytes,
                )
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
