import {readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../../child-env.js'
import {filterWeavatrixIgnored} from '../../path-ignore.js'

export const readText = (path) => {
    try { return readFileSync(path, 'utf8') } catch { return null }
}

export const readJson = (path) => {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export const readRepoText = (boundary, relativePath) => {
    const resolved = boundary.resolve(relativePath)
    return resolved.ok ? readText(resolved.path) : null
}

export const readRepoJson = (boundary, relativePath) => {
    const resolved = boundary.resolve(relativePath)
    return resolved.ok ? readJson(resolved.path) : null
}

const SKIP_DIRS = new Set([
    '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', 'out',
    'release', 'weavatrix-graphs', '__pycache__', '.venv', 'venv', 'env', '.tox', 'site-packages',
    '.mypy_cache', '.pytest_cache',
])

export function listRepoFiles(repoRoot) {
    try {
        const result = spawnSync('git', ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
            encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
            env: childProcessEnv(),
        })
        if (result.status === 0) {
            const files = String(result.stdout || '').split('\0').filter(Boolean).map((file) => file.replace(/\\/g, '/'))
            return filterWeavatrixIgnored(repoRoot, files)
        }
    } catch { /* non-Git repo or git unavailable: use the bounded walker below */ }

    const files = []
    const walk = (absolute, parts = []) => {
        let entries = []
        try { entries = readdirSync(absolute, {withFileTypes: true}) } catch { return }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(join(absolute, entry.name), [...parts, entry.name])
            } else if (entry.isFile()) files.push([...parts, entry.name].join('/'))
        }
    }
    walk(repoRoot)
    return filterWeavatrixIgnored(repoRoot, files)
}
