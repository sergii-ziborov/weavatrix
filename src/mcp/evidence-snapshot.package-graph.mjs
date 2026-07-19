import {readFileSync, statSync} from 'node:fs'
import {createRepoBoundary} from '../repo-path.js'
import {STATE} from './evidence-snapshot.common.mjs'
import {parseBunLock, parseJsonc} from './evidence/bun-lock-graph.mjs'
import {MAX_LOCKFILE_BYTES, emptyGraph} from './evidence/package-graph-common.mjs'
import {parsePackageLock} from './evidence/package-lock-graph.mjs'

const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json', 'bun.lock']

export function buildPackageDependencyGraph(repoRoot) {
    const boundary = createRepoBoundary(repoRoot)
    if (!boundary.root) return emptyGraph(STATE.ERROR, 'INVALID_REPOSITORY_ROOT')

    let selected = null
    for (const lockfile of LOCKFILES) {
        const resolved = boundary.resolve(lockfile)
        if (resolved.ok) {
            selected = {lockfile, path: resolved.path}
            break
        }
    }
    if (!selected) return emptyGraph(STATE.NOT_APPLICABLE, 'PACKAGE_LOCK_V2_V3_NOT_FOUND')

    try {
        if (statSync(selected.path).size > MAX_LOCKFILE_BYTES) {
            return emptyGraph(STATE.ERROR, 'PACKAGE_LOCK_SIZE_LIMIT_REACHED', {lockfile: selected.lockfile})
        }
        const raw = readFileSync(selected.path, 'utf8')
        if (selected.lockfile === 'bun.lock') return parseBunLock(parseJsonc(raw), selected.lockfile)
        return parsePackageLock(JSON.parse(raw), selected.lockfile)
    } catch {
        return emptyGraph(STATE.ERROR, 'PACKAGE_LOCK_READ_ERROR', {lockfile: selected.lockfile})
    }
}
