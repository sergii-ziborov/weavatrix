import {runGit} from '../git-exec.js'

export function gitLines(repoRoot, args) {
    const result = runGit(repoRoot, args)
    if (result.status !== 0) return null
    return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}
