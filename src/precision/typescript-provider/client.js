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
        // Returns the raw LSP WorkspaceEdit normalized to repo-relative files. Purely a read:
        // nothing is applied here (workspace/applyEdit stays refused as read-only); the caller
        // turns this into an edit plan for review. URIs outside the repository are reported,
        // never silently dropped, and resource operations (create/rename/delete file) are
        // surfaced as a count so planners can refuse them explicitly.
        async rename(relPath, position, newName, renameTimeoutMs = timeoutMs) {
            const normalized = client.normalizer.toUri(relPath)
            const result = await client.request('textDocument/rename', {
                textDocument: {uri: normalized.uri},
                position,
                newName,
            }, {timeoutMs: renameTimeoutMs})
            const files = []
            const outsideRepository = []
            let resourceOperations = 0
            const collect = (uri, edits) => {
                let file
                try {
                    file = client.normalizer.fromUri(uri).file
                } catch (error) {
                    if (error instanceof RangeError) {
                        outsideRepository.push(String(uri))
                        return
                    }
                    throw error
                }
                files.push({file, edits: (edits || []).map((edit) => ({range: edit.range, newText: String(edit.newText ?? '')}))})
            }
            if (result && typeof result === 'object' && result.changes && typeof result.changes === 'object') {
                for (const [uri, edits] of Object.entries(result.changes)) collect(uri, edits)
            }
            if (result && Array.isArray(result.documentChanges)) {
                for (const change of result.documentChanges) {
                    if (!change || typeof change !== 'object') continue
                    if (typeof change.kind === 'string') {
                        resourceOperations += 1
                        continue
                    }
                    collect(change.textDocument?.uri, change.edits)
                }
            }
            return {files, outsideRepository, resourceOperations}
        },
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
