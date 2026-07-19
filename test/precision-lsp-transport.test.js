import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {
    activeLspClientCount,
    ContentLengthMessageParser,
    createRepoUriNormalizer,
    lspChildProcessEnv,
    LspProtocolError,
    shutdownActiveLspClients,
    startStdioLspClient,
} from '../src/precision/lsp-client.js'
import {
    classifyTypeScriptReferenceUsage,
    createTypeScriptLspClient,
    typeScriptLspAvailability,
    typeScriptLanguageId,
    typeScriptProjectSafety,
} from '../src/precision/typescript-lsp-provider.js'
import {frame} from './helpers/precision-lsp-fixtures.js'

test('ContentLengthMessageParser handles byte-counted fragmented and coalesced messages', () => {
    const messages = []
    const parser = new ContentLengthMessageParser({onMessage: (message) => messages.push(message)})
    const first = frame({jsonrpc: '2.0', id: 1, result: 'Ñ‚Ð¾Ñ‡Ð½Ð¾'})
    const second = frame({jsonrpc: '2.0', method: 'ready', params: {value: true}}, 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n')
    parser.push(first.subarray(0, 7))
    parser.push(Buffer.concat([first.subarray(7), second]))
    assert.deepEqual(messages, [
        {jsonrpc: '2.0', id: 1, result: 'Ñ‚Ð¾Ñ‡Ð½Ð¾'},
        {jsonrpc: '2.0', method: 'ready', params: {value: true}},
    ])
})

test('ContentLengthMessageParser rejects duplicate, malformed, and oversized lengths', () => {
    assert.throws(
        () => new ContentLengthMessageParser({onMessage() {}}).push(
            Buffer.from('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}'),
        ),
        LspProtocolError,
    )
    assert.throws(
        () => new ContentLengthMessageParser({onMessage() {}}).push(
            Buffer.from('Content-Length: 2x\r\n\r\n{}'),
        ),
        LspProtocolError,
    )
    assert.throws(
        () => new ContentLengthMessageParser({onMessage() {}, maxMessageBytes: 8}).push(
            Buffer.from('Content-Length: 9\r\n\r\n123456789'),
        ),
        /exceeds 8 byte limit/,
    )
})

test('LSP child environment drops credentials, proxies, NODE_OPTIONS, and repo-controlled PATH entries', () => {
    const env = lspChildProcessEnv({
        WEAVATRIX_SYNC_TOKEN: 'secret',
        NODE_AUTH_TOKEN: 'secret',
        OPENAI_API_KEY: 'secret',
        HTTPS_PROXY: 'http://proxy.invalid',
        NODE_OPTIONS: '--require ./repo-hook.js',
        PATH: 'C:\\untrusted-repo\\node_modules\\.bin',
    })
    assert.equal(env.WEAVATRIX_SYNC_TOKEN, undefined)
    assert.equal(env.NODE_AUTH_TOKEN, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.HTTPS_PROXY, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.doesNotMatch(env.PATH, /untrusted-repo/i)
})

