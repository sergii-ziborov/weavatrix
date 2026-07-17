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

function frame(value, extraHeaders = '') {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    return Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n${extraHeaders}\r\n`, 'ascii'),
        body,
    ])
}

test('ContentLengthMessageParser handles byte-counted fragmented and coalesced messages', () => {
    const messages = []
    const parser = new ContentLengthMessageParser({onMessage: (message) => messages.push(message)})
    const first = frame({jsonrpc: '2.0', id: 1, result: 'точно'})
    const second = frame({jsonrpc: '2.0', method: 'ready', params: {value: true}}, 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n')
    parser.push(first.subarray(0, 7))
    parser.push(Buffer.concat([first.subarray(7), second]))
    assert.deepEqual(messages, [
        {jsonrpc: '2.0', id: 1, result: 'точно'},
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

const FAKE_SERVER = String.raw`
const inside = process.argv[2]
const outside = process.argv[3]
const range = {start: {line: 0, character: 0}, end: {line: 0, character: 6}}
let buffer = Buffer.alloc(0)
let expected = null

function send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const framed = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body])
    const split = Math.max(1, Math.floor(framed.length / 2))
    process.stdout.write(framed.subarray(0, split))
    setImmediate(() => process.stdout.write(framed.subarray(split)))
}

function handle(message) {
    if (message.method === 'initialize') {
        send({jsonrpc: '2.0', id: message.id, result: {capabilities: {definitionProvider: true, referencesProvider: true}, inside}})
    } else if (message.method === 'textDocument/definition') {
        send({jsonrpc: '2.0', id: message.id, result: [
            {targetUri: inside, targetRange: range, targetSelectionRange: range},
            {uri: outside, range},
        ]})
    } else if (message.method === 'textDocument/references') {
        send({jsonrpc: '2.0', id: message.id, result: [{uri: inside, range}, {uri: outside, range}]})
    } else if (message.method === 'shutdown') {
        send({jsonrpc: '2.0', id: message.id, result: null})
    } else if (message.method === 'exit') {
        process.exit(0)
    }
}

process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length) {
        if (expected == null) {
            const marker = buffer.indexOf('\r\n\r\n')
            if (marker < 0) return
            const header = buffer.subarray(0, marker).toString('ascii')
            expected = Number(/Content-Length: ([0-9]+)/i.exec(header)[1])
            buffer = buffer.subarray(marker + 4)
        }
        if (buffer.length < expected) return
        const body = buffer.subarray(0, expected)
        buffer = buffer.subarray(expected)
        expected = null
        handle(JSON.parse(body.toString('utf8')))
    }
})
`

test('stdio LSP client initializes, filters external locations, and shuts down', {timeout: 20_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-lsp-client-'))
    const repo = join(parent, 'repo')
    const source = join(repo, 'src', 'entry.ts')
    const outside = join(parent, 'external.ts')
    const serverPath = join(parent, 'fake-lsp.mjs')
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(source, 'export const answer = 42\n')
    writeFileSync(outside, 'export const external = true\n')
    writeFileSync(serverPath, FAKE_SERVER)
    assert.equal(createRepoUriNormalizer(repo).fromUri(pathToFileURL(source).href).file, 'src/entry.ts')

    const client = await startStdioLspClient({
        repoRoot: repo,
        executablePath: process.execPath,
        args: [serverPath, pathToFileURL(source).href, pathToFileURL(outside).href],
        requestTimeoutMs: 3_000,
    })
    assert.equal(activeLspClientCount(), 1)
    try {
        const initialized = await client.initialize()
        assert.equal(initialized.capabilities.definitionProvider, true)
        assert.equal(initialized.inside, pathToFileURL(source).href)
        await client.openDocument({filePath: 'src/entry.ts', text: 'export const answer = 42\n', languageId: 'typescript'})
        await assert.rejects(
            client.openDocument({filePath: '../external.ts', text: '', languageId: 'typescript'}),
            /outside the repository/,
        )
        assert.deepEqual(await client.definition({filePath: 'src/entry.ts', position: {line: 0, character: 13}}), [
            {file: 'src/entry.ts', range: {start: {line: 0, character: 0}, end: {line: 0, character: 6}}},
        ])
        assert.deepEqual(await client.references({filePath: 'src/entry.ts', position: {line: 0, character: 13}}), [
            {file: 'src/entry.ts', range: {start: {line: 0, character: 0}, end: {line: 0, character: 6}}},
        ])
        assert.equal(await client.closeDocument('src/entry.ts'), true)
        assert.equal(await client.closeDocument('src/entry.ts'), false)
    } finally {
        await client.shutdown({timeoutMs: 3_000})
        assert.equal(activeLspClientCount(), 0)
        rmSync(parent, {recursive: true, force: true})
    }
})

test('global LSP cleanup force-terminates a provider that ignores protocol exit', {timeout: 10_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-lsp-cleanup-'))
    const repo = join(parent, 'repo')
    const serverPath = join(parent, 'hanging-lsp.mjs')
    mkdirSync(repo, {recursive: true})
    writeFileSync(serverPath, "process.stdin.resume()\nsetInterval(() => {}, 1000)\n")

    let client
    try {
        client = await startStdioLspClient({
            repoRoot: repo,
            executablePath: process.execPath,
            args: [serverPath],
            requestTimeoutMs: 2_000,
        })
        assert.equal(activeLspClientCount(), 1)
        const startedAt = Date.now()
        const cleanup = await shutdownActiveLspClients({timeoutMs: 1_500})
        assert.equal(cleanup.requested, 1)
        assert.equal(cleanup.remaining, 0)
        assert.ok(Date.now() - startedAt < 4_000, 'global cleanup must stay bounded')
        assert.equal(activeLspClientCount(), 0)
    } finally {
        client?.kill()
        await client?.waitForExit(2_000)
        rmSync(parent, {recursive: true, force: true, maxRetries: 20, retryDelay: 50})
    }
})

test('POSIX forced cleanup terminates the provider process group including grandchildren', {
    timeout: 10_000,
    skip: process.platform === 'win32',
}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-lsp-process-group-'))
    const repo = join(parent, 'repo')
    const serverPath = join(parent, 'group-lsp.mjs')
    const pidPath = join(parent, 'grandchild.pid')
    mkdirSync(repo, {recursive: true})
    writeFileSync(serverPath, `
import {spawn} from 'node:child_process'
import {writeFileSync} from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'})
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))
process.stdin.resume()
setInterval(() => {}, 1000)
`)

    let client
    let grandchildPid = null
    const waitFor = async (predicate, timeoutMs = 2_000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (predicate()) return true
            await new Promise((resolveWait) => setTimeout(resolveWait, 25))
        }
        return predicate()
    }
    try {
        client = await startStdioLspClient({
            repoRoot: repo,
            executablePath: process.execPath,
            args: [serverPath],
            requestTimeoutMs: 2_000,
        })
        assert.equal(await waitFor(() => existsSync(pidPath)), true)
        grandchildPid = Number(readFileSync(pidPath, 'utf8'))
        assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
        client.kill()
        await client.waitForExit(2_000)
        assert.equal(await waitFor(() => {
            try { process.kill(grandchildPid, 0); return false } catch { return true }
        }), true, 'grandchild must not survive forced provider cleanup')
    } finally {
        client?.kill()
        if (grandchildPid) try { process.kill(grandchildPid, 'SIGKILL') } catch { /* already gone */ }
        rmSync(parent, {recursive: true, force: true})
    }
})

test('TypeScript provider discovery is explicit and language ids are deterministic', () => {
    const availability = typeScriptLspAvailability()
    assert.equal(availability.provider, 'typescript-language-server')
    assert.equal(typeof availability.available, 'boolean')
    assert.equal(typeScriptLanguageId('src/a.ts'), 'typescript')
    assert.equal(typeScriptLanguageId('src/a.tsx'), 'typescriptreact')
    assert.equal(typeScriptLanguageId('src/a.mjs'), 'javascript')
    assert.equal(typeScriptLanguageId('src/a.jsx'), 'javascriptreact')
    assert.equal(typeScriptLanguageId('src/a.py'), null)
})

test('TypeScript reference usage distinguishes type queries from runtime values', () => {
    const source = [
        'function helper() {}',
        'type Helper = typeof helper;',
        'const called = helper();',
        'const inspected = typeof helper;',
        'class Child extends Base implements Contract {}',
    ].join('\n')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 1, character: 21}), 'type')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 2, character: 15}), 'value')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 3, character: 25}), 'value')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 4, character: 20}), 'value')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 4, character: 36}), 'type')
})

test('TypeScript project safety rejects plugins in direct, extended, and referenced configs', async (t) => {
    const makeFixture = () => {
        const root = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-safety-'))
        mkdirSync(join(root, 'src'), {recursive: true})
        writeFileSync(join(root, 'src', 'main.ts'), 'export const main = 1\n')
        return root
    }
    await t.test('direct config', () => {
        const root = makeFixture()
        try {
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
                compilerOptions: {plugins: [{name: 'evil-plugin'}]},
                files: ['src/main.ts'],
            }))
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIGURED_TSSERVER_PLUGINS')
        } finally { rmSync(root, {recursive: true, force: true}) }
    })
    await t.test('extends chain', () => {
        const root = makeFixture()
        try {
            writeFileSync(join(root, 'base.json'), JSON.stringify({
                compilerOptions: {plugins: [{name: 'evil-plugin'}]},
            }))
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
                extends: './base.json',
                files: ['src/main.ts'],
            }))
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIGURED_TSSERVER_PLUGINS')
        } finally { rmSync(root, {recursive: true, force: true}) }
    })
    await t.test('project reference', () => {
        const root = makeFixture()
        try {
            mkdirSync(join(root, 'packages', 'child'), {recursive: true})
            writeFileSync(join(root, 'packages', 'child', 'child.ts'), 'export const child = 1\n')
            writeFileSync(join(root, 'packages', 'child', 'tsconfig.json'), JSON.stringify({
                compilerOptions: {composite: true, plugins: [{name: 'evil-plugin'}]},
                files: ['child.ts'],
            }))
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
                files: ['src/main.ts'],
                references: [{path: './packages/child'}],
            }))
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIGURED_TSSERVER_PLUGINS')
        } finally { rmSync(root, {recursive: true, force: true}) }
    })
})

test('TypeScript project safety refuses unresolved and outside extends configs', async (t) => {
    const run = (extendsPath) => {
        const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-boundary-'))
        const root = join(parent, 'repo')
        mkdirSync(join(root, 'src'), {recursive: true})
        writeFileSync(join(root, 'src', 'main.ts'), 'export const main = 1\n')
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({extends: extendsPath, files: ['src/main.ts']}))
        try { return typeScriptProjectSafety(root, ['src/main.ts']) }
        finally { rmSync(parent, {recursive: true, force: true}) }
    }
    await t.test('unresolved', () => {
        const safety = run('./missing.json')
        assert.equal(safety.safe, false)
        assert.match(safety.reason, /CONFIG/)
    })
    await t.test('outside repository', () => {
        const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-outside-'))
        const root = join(parent, 'repo')
        mkdirSync(join(root, 'src'), {recursive: true})
        writeFileSync(join(parent, 'base.json'), JSON.stringify({compilerOptions: {strict: true}}))
        writeFileSync(join(root, 'src', 'main.ts'), 'export const main = 1\n')
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({extends: '../base.json', files: ['src/main.ts']}))
        try {
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIG_OUTSIDE_REPOSITORY')
        } finally { rmSync(parent, {recursive: true, force: true}) }
    })
})

test('TypeScript project discovery stops at the synchronous entry and deadline budgets', () => {
    const root = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-budget-'))
    mkdirSync(join(root, 'src'), {recursive: true})
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({include: ['src/**/*.ts']}))
    for (let index = 0; index < 8; index++) {
        writeFileSync(join(root, 'src', `file-${index}.ts`), `export const value${index} = ${index}\n`)
    }
    try {
        const entryLimited = typeScriptProjectSafety(root, ['src/file-0.ts'], {maxDirectoryEntries: 4})
        assert.equal(entryLimited.safe, false)
        assert.equal(entryLimited.reason, 'PROJECT_INPUT_LIMIT')

        const deadlineLimited = typeScriptProjectSafety(root, ['src/file-0.ts'], {deadline: Date.now() - 1})
        assert.equal(deadlineLimited.safe, false)
        assert.equal(deadlineLimited.reason, 'SAFETY_DEADLINE')
    } finally { rmSync(root, {recursive: true, force: true}) }
})

test('bundled TypeScript language server returns semantic definitions and references', {timeout: 30_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-lsp-'))
    const repo = join(parent, 'repo')
    const libraryText = 'export function greet(name: string) {\n  return `hello ${name}`\n}\n'
    const applicationText = "import {greet} from './lib.js'\nexport const message = greet('world')\n"
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'typescript-lsp-fixture', private: true, type: 'module'}))
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({compilerOptions: {module: 'NodeNext', moduleResolution: 'NodeNext', strict: true}}))
    writeFileSync(join(repo, 'src', 'lib.ts'), libraryText)
    writeFileSync(join(repo, 'src', 'app.ts'), applicationText)

    let provider
    try {
        provider = await createTypeScriptLspClient({repoRoot: repo, timeoutMs: 10_000})
        assert.equal(provider.provider, 'typescript-language-server')
        await provider.openDocument('src/lib.ts', libraryText)
        await provider.openDocument('src/app.ts', applicationText)
        const definitions = await provider.definition('src/app.ts', {line: 1, character: 24})
        assert.ok(definitions.some((location) => location.file === 'src/lib.ts'), JSON.stringify(definitions))
        const references = await provider.references('src/lib.ts', {line: 0, character: 17}, true)
        assert.ok(references.some((location) => location.file === 'src/lib.ts'), JSON.stringify(references))
        assert.ok(references.some((location) => location.file === 'src/app.ts'), JSON.stringify(references))
    } finally {
        await provider?.close()
        rmSync(parent, {recursive: true, force: true})
    }
})

test('bundled TypeScript provider never loads a repository-local tsserver plugin', {timeout: 30_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-plugin-'))
    const repo = join(parent, 'repo')
    const pluginDir = join(repo, 'node_modules', 'evil-plugin')
    const sentinel = join(parent, 'plugin-loaded.txt')
    const sourceText = 'export function answer() { return 42 }\nexport const value = answer()\n'
    mkdirSync(join(repo, 'src'), {recursive: true})
    mkdirSync(pluginDir, {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'typescript-plugin-fixture', private: true}))
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {plugins: [{name: 'evil-plugin'}]},
        include: ['src/**/*.ts'],
    }))
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({name: 'evil-plugin', version: '1.0.0', main: 'index.js'}))
    writeFileSync(join(pluginDir, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'loaded')\nmodule.exports = () => ({create: info => info.languageService})\n`)
    writeFileSync(join(repo, 'src', 'main.ts'), sourceText)

    let provider
    try {
        provider = await createTypeScriptLspClient({repoRoot: repo, timeoutMs: 10_000})
        await provider.openDocument('src/main.ts', sourceText)
        const references = await provider.references('src/main.ts', {line: 0, character: 16}, true)
        assert.ok(references.some((location) => location.file === 'src/main.ts'), JSON.stringify(references))
        assert.equal(existsSync(sentinel), false, 'repo-local TypeScript plugins must never execute')
    } finally {
        await provider?.close()
        rmSync(parent, {recursive: true, force: true})
    }
})
