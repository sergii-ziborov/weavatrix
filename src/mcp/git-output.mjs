import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../child-env.js'

export function gitLines(repoRoot, args) {
    const result = spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8', timeout: 8000, env: childProcessEnv(), windowsHide: true,
    })
    if (result.status !== 0) return null
    return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}
