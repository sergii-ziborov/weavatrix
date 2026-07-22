import {resolve} from 'node:path'
import {startStdioLspClient} from '../lsp-client.js'
import {WEAVATRIX_VERSION} from '../../version.js'
import {
    discoverTypeScriptProvider,
    typeScriptLanguageId,
    typeScriptLspContract,
} from './discovery.js'
import {isolateTypeScriptRuntime} from './isolated-runtime.js'

/** Starts Weavatrix's bundled TypeScript server without executing repository configuration. */
export async function createTypeScriptLspClient({repoRoot, timeoutMs = 10_000} = {}) {
    const discovered = discoverTypeScriptProvider()
    const absoluteRepoRoot = resolve(repoRoot)
    const isolated = isolateTypeScriptRuntime(discovered.tsserverPath)
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
                    rename: {},
                    publishDiagnostics: {relatedInformation: false},
                },
            },
            initializationOptions: {
                hostInfo: 'weavatrix',
                disableAutomaticTypingAcquisition: true,
                tsserver: {path: isolated.tsserverPath},
                // An explicit empty list keeps the language-server plugin manager
                // from adding --globalPlugins or --pluginProbeLocations. tsserver's
                // local-plugin loading remains disabled by default as well.
                plugins: [],
            },
        })
    } catch (error) {
        client?.kill(error)
        isolated.cleanup()
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
        // Generic read-only JSON-RPC passthrough plus URI normalization, so consumers outside
        // the core (weavatrix-refactor) can issue their own read-only LSP requests. The client
        // still refuses workspace/applyEdit, so nothing here can apply an edit.
        request(method, params, options) { return client.request(method, params, options) },
        toUri(relPath) { return client.normalizer.toUri(relPath) },
        fromUri(uri) { return client.normalizer.fromUri(uri) },
        definition(relPath, position) { return client.definition({filePath: relPath, position}) },
        closeDocument(relPath) { return client.closeDocument(relPath) },
        async close(shutdownTimeoutMs = timeoutMs) {
            try { return await client.shutdown({timeoutMs: shutdownTimeoutMs}) }
            finally { isolated.cleanup() }
        },
        kill() {
            try { client.kill() }
            finally { isolated.cleanup() }
        },
    })
}
