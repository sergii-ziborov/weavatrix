import {readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {runGit} from '../../git-exec.js'
import {resolveRepoPath} from '../../repo-path.js'
import {mergePrecisionOverlay, precisionSemanticInputsMatch, readPrecisionOverlay} from '../../precision/lsp-overlay.js'

let stalenessCache = {key: '', checkedAt: 0, info: null}

export function graphStaleness(ctx) {
    const now = Date.now()
    if (stalenessCache.info && stalenessCache.key === ctx.graphPath && now - stalenessCache.checkedAt < 60_000) return stalenessCache.info
    const info = {builtAt: null, headAt: null, stale: false, behind: null}
    try { info.builtAt = statSync(ctx.graphPath).mtime } catch { /* no graph file */ }
    if (ctx.repoRoot && info.builtAt) {
        try {
            const head = runGit(ctx.repoRoot, ['log', '-1', '--format=%cI'], {timeout: 4000})
            const iso = (head.stdout || '').trim()
            if (head.status === 0 && iso) {
                info.headAt = new Date(iso)
                if (info.headAt > info.builtAt) {
                    info.stale = true
                    const count = runGit(ctx.repoRoot, ['rev-list', '--count', `--since=${info.builtAt.toISOString()}`, 'HEAD'], {timeout: 4000})
                    if (count.status === 0) info.behind = Number(count.stdout.trim()) || null
                }
            }
        } catch { /* git unavailable */ }
        try {
            const status = runGit(ctx.repoRoot, ['status', '--porcelain'], {timeout: 4000})
            if (status.status === 0) {
                let newer = 0
                for (const line of String(status.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, 200)) {
                    const path = line.slice(3).trim().replace(/^"|"$/g, '')
                    try { if (statSync(join(ctx.repoRoot, path)).mtime > info.builtAt) newer++ } catch { newer++ }
                }
                info.dirtyNewer = newer
                if (newer > 0) info.stale = true
            }
        } catch { /* git unavailable */ }
    }
    stalenessCache = {key: ctx.graphPath, checkedAt: now, info}
    return info
}

export const resetStalenessCache = () => { stalenessCache = {key: '', checkedAt: 0, info: null} }

export function stalenessLine(ctx) {
    const state = graphStaleness(ctx)
    if (!state.stale) return null
    const bits = []
    if (state.headAt && state.headAt > state.builtAt) bits.push(`${state.behind != null ? `${state.behind} commit${state.behind === 1 ? '' : 's'}` : 'commits'} newer than the graph`)
    if (state.dirtyNewer) bits.push(`${state.dirtyNewer} uncommitted file(s) edited after the build`)
    return `Warning: graph may be stale — the repo has ${bits.join(' and ')} (built ${state.builtAt.toISOString()}). Line numbers may have drifted; call rebuild_graph.`
}

export function fileStalenessNote(ctx, sourceFile) {
    if (!ctx?.repoRoot || !sourceFile) return null
    const state = graphStaleness(ctx)
    if (!state.builtAt) return null
    try {
        const resolved = resolveRepoPath(ctx.repoRoot, String(sourceFile))
        if (resolved.ok && statSync(resolved.path).mtime > state.builtAt) {
            return `Note: ${sourceFile} changed after the graph was built — line numbers above may have drifted (rebuild_graph refreshes them).`
        }
    } catch { /* missing file */ }
    return null
}

let rawGraphCache = {path: '', mtimeMs: 0, data: null}

export function rawGraph(ctx) {
    const mtimeMs = statSync(ctx.graphPath).mtimeMs
    if (!rawGraphCache.data || rawGraphCache.path !== ctx.graphPath || rawGraphCache.mtimeMs !== mtimeMs) {
        rawGraphCache = {path: ctx.graphPath, mtimeMs, data: JSON.parse(readFileSync(ctx.graphPath, 'utf8'))}
    }
    return rawGraphCache.data
}

export function effectiveRawGraph(ctx) {
    const raw = rawGraph(ctx)
    const overlay = readPrecisionOverlay(ctx.graphPath, raw)
    const safeOverlay = ctx?.repoRoot && typeof overlay?.semanticInputFingerprint === 'string'
        && !precisionSemanticInputsMatch(overlay, ctx.repoRoot, raw)
        ? null : overlay
    return mergePrecisionOverlay(raw, safeOverlay)
}
