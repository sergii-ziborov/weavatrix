import {dirname} from 'node:path'
import {createRepoBoundary} from '../../repo-path.js'
import {parseRequirementsNames, parsePyprojectDeps, parsePipfileDeps, pep503} from '../manifests.js'
import {listRepoFiles, readRepoText} from './repo-files.js'

const normalizeRoot = (root) => {
    const value = String(root || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
    return value === '.' ? '' : value
}

// Python dependencies are owned by the nearest manifest root, including nested services.
export function collectPyManifest(repoRoot) {
    const boundary = createRepoBoundary(repoRoot)
    const scopes = new Map()
    const scopeFor = (root) => {
        const normalized = normalizeRoot(root)
        if (!scopes.has(normalized)) scopes.set(normalized, {root: normalized, present: false, deps: [], manifests: []})
        return scopes.get(normalized)
    }
    const addManifest = (root, manifest, parsedDeps, present = true) => {
        if (!present) return
        const scope = scopeFor(root)
        scope.present = true
        scope.manifests.push(manifest)
        scope.deps.push(...parsedDeps.map((dep) => ({...dep, manifest})))
    }
    const files = listRepoFiles(repoRoot)
    for (const file of files.filter((name) => /(^|\/)requirements[\w.-]*\.(?:txt|in)$/i.test(name)
        || /(^|\/)requirements\/[^/]+\.(?:txt|in)$/i.test(name))) {
        const text = readRepoText(boundary, file)
        if (text == null) continue
        const parent = normalizeRoot(dirname(file))
        const root = /(^|\/)requirements$/i.test(parent) ? normalizeRoot(dirname(parent)) : parent
        const dev = /dev|test|lint|doc|ci/i.test(file.slice(file.lastIndexOf('/') + 1))
        addManifest(root, file, parseRequirementsNames(text).map((dep) => ({...dep, dev})))
    }
    for (const file of files.filter((name) => /(^|\/)pyproject\.toml$/i.test(name))) {
        const parsed = parsePyprojectDeps(readRepoText(boundary, file))
        addManifest(dirname(file), file, parsed.deps, parsed.present)
    }
    for (const file of files.filter((name) => /(^|\/)Pipfile$/i.test(name))) {
        const parsed = parsePipfileDeps(readRepoText(boundary, file))
        addManifest(dirname(file), file, parsed.deps, parsed.present)
    }
    const normalizedScopes = [...scopes.values()]
        .map((scope) => {
            const seen = new Set()
            return {
                ...scope,
                manifests: [...new Set(scope.manifests)].sort(),
                deps: scope.deps.filter((dep) => {
                    const key = pep503(dep.name)
                    if (!key || seen.has(key)) return false
                    seen.add(key)
                    return true
                }),
            }
        })
        .sort((left, right) => right.root.length - left.root.length || left.root.localeCompare(right.root))
    return {
        present: normalizedScopes.some((scope) => scope.present),
        deps: normalizedScopes.flatMap((scope) => scope.deps),
        scopes: normalizedScopes,
    }
}
