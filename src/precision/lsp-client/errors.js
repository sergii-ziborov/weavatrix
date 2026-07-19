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
