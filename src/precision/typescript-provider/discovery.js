import {existsSync, readFileSync, realpathSync} from 'node:fs'
import {dirname, extname, isAbsolute, join} from 'node:path'
import {createRequire} from 'node:module'

const requireFromWeavatrix = createRequire(import.meta.url)
const PROVIDER = 'typescript-language-server'
export const TYPESCRIPT_LSP_CAPABILITY_CONTRACT = 'typescript-references-v4-plugin-suppression'
let discoveredProvider = null

function resolveOwn(specifier) {
    const resolved = requireFromWeavatrix.resolve(specifier)
    if (!isAbsolute(resolved)) throw new Error(`Resolved dependency path is not absolute: ${specifier}`)
    return realpathSync.native(resolved)
}

function packageInfoFrom(startPath, expectedName) {
    let directory = dirname(startPath)
    for (let depth = 0; depth < 10; depth++) {
        const packagePath = join(directory, 'package.json')
        if (existsSync(packagePath)) {
            try {
                const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
                if (manifest.name === expectedName) {
                    return {directory, manifest, packagePath: realpathSync.native(packagePath)}
                }
            } catch { /* continue upward */ }
        }
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
    }
    throw new Error(`Could not locate ${expectedName} package metadata`)
}

function resolveServerCli() {
    const candidates = [
        'typescript-language-server',
        'typescript-language-server/lib/cli.mjs',
        'typescript-language-server/lib/cli.js',
    ]
    let lastError
    for (const candidate of candidates) {
        try {
            const path = resolveOwn(candidate)
            if (existsSync(path)) return path
        } catch (error) { lastError = error }
    }
    throw lastError || new Error('typescript-language-server CLI was not found')
}

function resolveTypeScriptServer() {
    const candidates = ['typescript/lib/tsserver.js', 'typescript/lib/_tsserver.js']
    let lastError
    for (const candidate of candidates) {
        try {
            const path = resolveOwn(candidate)
            if (existsSync(path)) return path
        } catch (error) { lastError = error }
    }
    try {
        const typescriptEntry = resolveOwn('typescript')
        for (const name of ['tsserver.js', '_tsserver.js']) {
            const candidate = join(dirname(typescriptEntry), name)
            if (existsSync(candidate)) return realpathSync.native(candidate)
        }
    } catch (error) { lastError = error }
    throw lastError || new Error('Bundled TypeScript tsserver was not found')
}

export function discoverTypeScriptProvider() {
    if (discoveredProvider) return discoveredProvider
    const cliPath = resolveServerCli()
    const tsserverPath = resolveTypeScriptServer()
    const serverPackage = packageInfoFrom(cliPath, PROVIDER)
    const typescriptPackage = packageInfoFrom(tsserverPath, 'typescript')
    discoveredProvider = Object.freeze({
        available: true,
        provider: PROVIDER,
        version: String(serverPackage.manifest.version || 'unknown'),
        typescriptVersion: String(typescriptPackage.manifest.version || 'unknown'),
        cliPath,
        tsserverPath,
    })
    return discoveredProvider
}

export function typeScriptLspAvailability() {
    try {
        const result = discoverTypeScriptProvider()
        return {
            available: true,
            provider: result.provider,
            version: result.version,
            typescriptVersion: result.typescriptVersion,
        }
    } catch (error) {
        return {
            available: false,
            provider: PROVIDER,
            version: null,
            typescriptVersion: null,
            reason: error?.code === 'MODULE_NOT_FOUND' ? 'DEPENDENCY_NOT_INSTALLED' : 'DISCOVERY_FAILED',
        }
    }
}

export function typeScriptLspContract() {
    const availability = typeScriptLspAvailability()
    return [
        TYPESCRIPT_LSP_CAPABILITY_CONTRACT,
        `${PROVIDER}@${availability.version || 'unavailable'}`,
        `typescript@${availability.typescriptVersion || 'unavailable'}`,
        `runtime@${process.platform}-${process.arch}-node${String(process.versions.node || '0').split('.')[0]}`,
    ].join('|')
}

export function typeScriptLanguageId(filePath) {
    const extension = extname(String(filePath)).toLowerCase()
    if (extension === '.ts' || extension === '.mts' || extension === '.cts') return 'typescript'
    if (extension === '.tsx') return 'typescriptreact'
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'javascript'
    if (extension === '.jsx') return 'javascriptreact'
    return null
}
