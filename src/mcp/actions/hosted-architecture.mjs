import {writeCachedArchitectureContract} from '../../analysis/architecture-contract.js'
import {graphHomeDir, graphOutDirForRepo} from '../../graph/layout.js'
import {registerRepository, repositoryRecord} from '../../graph/repo-registry.js'
import {toolResult} from '../tool-result.mjs'
const syncVersion = new URL(import.meta.url).search
const {syncDestination} = await import(new URL(`./graph-sync.mjs${syncVersion}`, import.meta.url).href)

export async function tPullArchitectureContract(g, args, ctx) {
    if (!ctx.repoRoot || !ctx.graphPath) return 'No active repository graph — open_repo first.'
    const syncUrl = process.env.WEAVATRIX_SYNC_URL
    const token = process.env.WEAVATRIX_SYNC_TOKEN
    if (!syncUrl || !token) return 'Hosted architecture pull is not configured. Use the hosted profile with WEAVATRIX_SYNC_URL and WEAVATRIX_SYNC_TOKEN, or keep .weavatrix/architecture.json locally.'
    let url
    try {
        const configured = process.env.WEAVATRIX_ARCHITECTURE_URL || new URL('/api/v1/architecture-contract', syncUrl).toString()
        url = syncDestination(configured).url
    } catch (error) { return `Hosted architecture pull is not configured safely: ${error.message}.` }
    const registry = repositoryRecord(ctx.repoRoot, graphHomeDir())
        || registerRepository({repoPath: ctx.repoRoot, graphDir: graphOutDirForRepo(ctx.repoRoot), graphHome: graphHomeDir()})
    const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeout_ms) || 30000))
    try {
        const res = await fetch(url, {
            headers: {authorization: `Bearer ${token}`, 'x-weavatrix-repository-id': registry.repositoryId},
            signal: AbortSignal.timeout(timeoutMs),
        })
        const body = await res.json().catch(() => null)
        if (!res.ok) {
            const serverCode = String(body?.error?.code || body?.state || '').toUpperCase()
            const state = res.status === 401 ? 'AUTH_REQUIRED'
                : res.status === 403 ? 'FORBIDDEN'
                    : res.status === 404 && ['REPOSITORY_NOT_FOUND', 'NOT_FOUND'].includes(serverCode) ? 'REPOSITORY_NOT_REGISTERED'
                        : res.status === 404 ? 'ENDPOINT_NOT_FOUND'
                        : res.status === 409 ? 'REPOSITORY_NOT_READY'
                            : 'HTTP_ERROR'
            const next = state === 'REPOSITORY_NOT_REGISTERED'
                ? 'The Hosted endpoint is reachable, but this UUID has not completed a preview-confirmed repository sync.'
                : state === 'ENDPOINT_NOT_FOUND'
                    ? 'The configured architecture endpoint does not exist; verify WEAVATRIX_ARCHITECTURE_URL or the URL derived from WEAVATRIX_SYNC_URL.'
                : res.status === 401 || res.status === 403
                    ? 'Check the hosted token and repository access; no local cache entry was changed.'
                    : res.status === 409
                        ? 'Sync/register this repository first, then create or pull its target contract.'
                        : 'Check the hosted service status and configured endpoint before retrying.'
            return toolResult(`Hosted architecture pull: ${state} (HTTP ${res.status}). ${next} The previous local contract cache remains unchanged.`, {
                state, httpStatus: res.status, serverCode: serverCode || null, cacheChanged: false,
            })
        }
        if (body?.state === 'NOT_CONFIGURED' || !body?.contract) return toolResult(
            'Hosted target architecture is NOT_CONFIGURED. Repository sync and authentication succeeded; define and save a target in the Architecture editor first.',
            {state: 'NOT_CONFIGURED', repositoryId: registry.repositoryId, cacheChanged: false},
        )
        const stored = writeCachedArchitectureContract(ctx.graphPath, body.contract)
        return `Pulled target architecture ${stored.contract.name} (${stored.contract.style}, ${stored.contract.enforcement}) into the local graph cache. get_architecture_contract and verify_architecture now use it.`
    } catch (error) {
        return `Hosted architecture pull failed: ${error.message}; the previous local contract, if any, remains active.`
    }
}
