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
import {FAKE_SERVER} from './helpers/precision-lsp-fixtures.js'
import {WEAVATRIX_VERSION} from '../src/version.js'

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
        assert.deepEqual(initialized.clientInfo, {name: 'weavatrix', version: WEAVATRIX_VERSION})
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
