import {resolve} from 'node:path'
import {startStdioLspClient} from '../lsp-client.js'
import {WEAVATRIX_VERSION} from '../../version.js'
import {
    discoverTypeScriptProvider,
    typeScriptLanguageId,
    typeScriptLspContract,
} from './discovery.js'

/** Starts Weavatrix's bundled TypeScript server without executing repository configuration. */
export async function createTypeScriptLspClient({repoRoot, timeoutMs = 10_000} = {}) {
    const discovered = discoverTypeScriptProvider()
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
        definition(relPath, position) { return client.definition({filePath: relPath, position}) },
        closeDocument(relPath) { return client.closeDocument(relPath) },
        close(shutdownTimeoutMs = timeoutMs) { return client.shutdown({timeoutMs: shutdownTimeoutMs}) },
        kill() { client.kill() },
    })
}
