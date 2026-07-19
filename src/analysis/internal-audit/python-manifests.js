import {dirname, posix} from 'node:path'
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
    const fileSet = new Set(files.map((file) => file.replace(/\\/g, '/')))
    const reasons = []
    for (const file of files.filter((name) => /(^|\/)requirements[\w.-]*\.(?:txt|in)$/i.test(name)
        || /(^|\/)requirements\/[^/]+\.(?:txt|in)$/i.test(name))) {
        const text = readRepoText(boundary, file)
        if (text == null) continue
        const parent = normalizeRoot(dirname(file))
        const root = /(^|\/)requirements$/i.test(parent) ? normalizeRoot(dirname(parent)) : parent
        const dev = /dev|test|lint|doc|ci/i.test(file.slice(file.lastIndexOf('/') + 1))
        addManifest(root, file, parseRequirementsNames(text).map((dep) => ({...dep, dev})))
        for (const match of text.matchAll(/^\s*(?:-r|--requirement|-c|--constraint)\s+(?:=\s*)?([^\s#]+)/gmi)) {
            const parentDir = normalizeRoot(dirname(file))
            const target = normalizeRoot(posix.normalize(`${parentDir ? `${parentDir}/` : ''}${match[1].replace(/\\/g, '/')}`))
            if (!target || target.startsWith('../') || !fileSet.has(target)) reasons.push(`${file}: referenced requirements file ${match[1]} was not discovered`)
        }
    }
    for (const file of files.filter((name) => /(^|\/)pyproject\.toml$/i.test(name))) {
        const text = readRepoText(boundary, file)
        const parsed = parsePyprojectDeps(text)
        const dependencyManifest = parsed.present || /^\s*\[(?:project|tool\.poetry)\]/m.test(text || '')
        addManifest(dirname(file), file, parsed.deps, dependencyManifest)
        if (/\bdynamic\s*=\s*\[[^\]]*["']dependencies["']/s.test(text || '')) reasons.push(`${file}: project dependencies are dynamic`)
    }
    for (const file of files.filter((name) => /(^|\/)Pipfile$/i.test(name))) {
        const text = readRepoText(boundary, file)
        const parsed = parsePipfileDeps(text)
        addManifest(dirname(file), file, parsed.deps, parsed.present || /^\s*\[(?:packages|dev-packages)\]/mi.test(text || ''))
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
        completeness: reasons.length ? 'PARTIAL' : 'COMPLETE',
        reasons: [...new Set(reasons)].sort(),
    }
}
