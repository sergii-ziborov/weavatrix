import {posix} from 'node:path'

export const normalizeDependencyScope = (root) => String(root || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
export const dependencyScopeRoot = (manifest) => {
    const root = posix.dirname(normalizeDependencyScope(manifest))
    return root === '.' ? '' : root
}
export const dependencyScopeOwnsFile = (scope, file) => !scope || file === scope || String(file || '').startsWith(`${scope}/`)

// Bind the ecosystem-specific core without introducing a facade/helper import cycle.
export function createScopedDepFindings(computeDepFindings) {
    return function computeScopedDepFindings({
        externalImports = [], packageScopes = [], workspacePkgNames = new Set(), configTexts = new Map(),
        sourceTexts = new Map(), nonRuntimeRoots = [], sourceFiles = [],
    } = {}) {
        const scopes = packageScopes.length
            ? packageScopes.map((scope) => ({...scope, root: normalizeDependencyScope(scope.root)})).sort((a, b) => b.root.length - a.root.length)
            : [{root: '', manifest: 'package.json', pkg: {}, aliases: []}]
        const importsByScope = new Map(scopes.map((scope) => [scope, []]))
        const sourceFilesByScope = new Map(scopes.map((scope) => [scope, []]))
        const sourceTextsByScope = new Map(scopes.map((scope) => [scope, new Map()]))
        for (const item of externalImports) {
            const owner = scopes.find((scope) => dependencyScopeOwnsFile(scope.root, item.file)) || scopes[scopes.length - 1]
            importsByScope.get(owner).push(item)
        }
        for (const file of sourceFiles) {
            const owner = scopes.find((scope) => dependencyScopeOwnsFile(scope.root, file)) || scopes[scopes.length - 1]
            sourceFilesByScope.get(owner).push(file)
        }
        for (const [file, text] of sourceTexts) {
            const owner = scopes.find((scope) => dependencyScopeOwnsFile(scope.root, file)) || scopes[scopes.length - 1]
            sourceTextsByScope.get(owner).set(file, text)
        }
        const configOwner = new Map()
        for (const [file] of configTexts) configOwner.set(file, scopes.find((scope) => dependencyScopeOwnsFile(scope.root, file)) || scopes[scopes.length - 1])
        const findings = [], usedPackages = new Map(), declared = new Set()
        for (const scope of scopes) {
            const scopeConfig = new Map([...configTexts].filter(([file]) => configOwner.get(file) === scope))
            const result = computeDepFindings({
                externalImports: importsByScope.get(scope), pkg: scope.pkg || {}, workspacePkgNames,
                configTexts: scopeConfig, sourceTexts: sourceTextsByScope.get(scope), aliases: scope.aliases || [], scope: scope.root,
                manifest: scope.manifest || (scope.root ? `${scope.root}/package.json` : 'package.json'),
                nonRuntimeRoots, sourceFiles: sourceFilesByScope.get(scope),
            })
            findings.push(...result.findings)
            for (const [name, use] of result.usedPackages) usedPackages.set(`${scope.root || '.'}:${name}`, use)
            for (const name of result.declared) declared.add(`${scope.root || '.'}:${name}`)
        }
        return {findings, usedPackages, declared}
    }
}
