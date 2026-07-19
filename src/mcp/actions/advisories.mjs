import {refreshAdvisories, storeMeta, DEFAULT_STORE} from '../../security/advisory-store.js'
import {collectInstalled} from '../../security/installed.js'

export async function tRefreshAdvisories(g, args, ctx) {
    if (!ctx.repoRoot) return 'No repo root — cannot collect installed packages.'
    const {installed} = collectInstalled(ctx.repoRoot)
    if (!installed.length) return 'No pinned packages found in lockfiles (npm/yarn/pip/poetry/uv/go) — nothing to query.'
    const res = await refreshAdvisories({installed, repoKey: ctx.repoRoot, timeoutMs: Number(args.timeout_ms) || undefined})
    if (res.ok === false) return `Advisory refresh failed: ${res.error}`
    const meta = storeMeta()
    return [
        `Advisory store ${res.status === 'PARTIAL' ? 'partially refreshed' : 'refreshed'} from OSV.dev: ${res.queriedOk ?? res.queried}/${res.queried} package versions queried successfully, ${res.vulnerable} with known advisories (${res.fetched} advisory records fetched).`,
        res.unsupported ? `${res.unsupported} packages skipped (ecosystem not OSV-queryable — npm/PyPI/Go only).` : null,
        res.errors?.length ? `Partial: ${res.errors.length} request error(s), first: ${res.errors[0]}` : null,
        `Store: ${DEFAULT_STORE} (${meta.advisoryCount} advisories, fetched ${meta.fetchedAt}). run_audit now reflects it — offline.`,
    ].filter(Boolean).join('\n')
}

