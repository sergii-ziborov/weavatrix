// Build a source graph for an immutable Git commit without mutating the user's worktree.
// The commit is first resolved to a full object id, then exported into a private temporary
// directory. No hooks are run and no branch/worktree metadata is changed.
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../child-env.js'
import {buildInternalGraph} from '../graph/internal-builder.js'

const SAFE_REF = /^(?!-)[A-Za-z0-9][A-Za-z0-9._\/@{}+~^-]{0,199}$/

function git(repoRoot, args, timeout = 15_000) {
    return spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8', timeout, env: childProcessEnv(), windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
    })
}

export function resolveGitCommit(repoRoot, requestedRef) {
    const ref = String(requestedRef || '').trim()
    if (!SAFE_REF.test(ref)) return {ok: false, error: 'base_ref contains unsupported characters'}
    const result = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    const commit = String(result.stdout || '').trim()
    if (result.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(commit)) {
        return {ok: false, error: `could not resolve Git ref "${ref}" to a commit`}
    }
    return {ok: true, ref, commit}
}

export async function withGitRefCheckout(repoRoot, requestedRef, operation) {
    const resolved = resolveGitCommit(repoRoot, requestedRef)
    if (!resolved.ok) return resolved
    const temp = mkdtempSync(join(tmpdir(), 'weavatrix-git-ref-'))
    const checkout = join(temp, 'repo')
    const archive = join(temp, 'source.tar')
    mkdirSync(checkout, {recursive: true})
    try {
        const archived = git(repoRoot, ['archive', '--format=tar', `--output=${archive}`, resolved.commit], 60_000)
        if (archived.status !== 0) {
            return {ok: false, error: `git archive failed for ${resolved.ref}: ${String(archived.stderr || '').trim() || 'unknown error'}`}
        }
        const extracted = spawnSync('tar', ['-xf', archive, '-C', checkout], {
            encoding: 'utf8', timeout: 60_000, env: childProcessEnv(), windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        })
        if (extracted.status !== 0) {
            return {ok: false, error: `temporary Git archive extraction failed: ${String(extracted.stderr || '').trim() || 'tar unavailable'}`}
        }
        // A normal build asks Git for tracked + non-ignored files. A plain archive has no .git
        // directory, so the fallback walker deliberately skips tracked dot paths such as
        // .github/workflows. Recreate only an index over the immutable archive (no commit, hooks or
        // checkout) so live and baseline graphs use the same file-universe semantics.
        const initialized = git(checkout, ['init', '--quiet'])
        if (initialized.status !== 0) {
            return {ok: false, error: `temporary Git index initialization failed: ${String(initialized.stderr || '').trim() || 'unknown error'}`}
        }
        const indexed = git(checkout, ['add', '--all', '--force'], 60_000)
        if (indexed.status !== 0) {
            return {ok: false, error: `temporary Git index population failed: ${String(indexed.stderr || '').trim() || 'unknown error'}`}
        }
        const value = await operation(checkout, resolved)
        return {ok: true, ref: resolved.ref, commit: resolved.commit, value}
    } catch (error) {
        return {ok: false, error: error instanceof Error ? error.message : String(error)}
    } finally {
        rmSync(temp, {recursive: true, force: true})
    }
}

export async function buildGraphAtGitRef(repoRoot, requestedRef) {
    const result = await withGitRefCheckout(repoRoot, requestedRef, async (checkout) => buildInternalGraph(checkout))
    return result.ok ? {...result, graph: result.value} : result
}
