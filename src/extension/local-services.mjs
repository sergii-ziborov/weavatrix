import {readFileSync, statSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {basename} from 'node:path'
import {graphStaleness} from '../mcp/graph-context.mjs'
import {createSyncPayload, createSyncPayloadV3, MAX_SYNC_BODY_BYTES} from '../mcp/sync-payload.mjs'
import {createEvidenceSnapshot} from '../mcp/evidence-snapshot.mjs'
import {graphHomeDir, graphOutDirForRepo} from '../graph/layout.js'
import {registerRepository, repositoryRecord} from '../graph/repo-registry.js'
import {writeCachedArchitectureContract} from '../analysis/architecture-contract.js'
import {collectInstalled} from '../security/installed.js'
import {toolResult} from '../mcp/tool-result.mjs'
import {
    commitAdvisoryRefresh, createAdvisoryQueryPlan, DEFAULT_STORE, storeMeta,
} from '../security/advisory-store.js'

const MAX_GRAPH_FILE_BYTES = 64 * 1024 * 1024

const repositoryLabel = (repoRoot) => {
    const safe = basename(String(repoRoot || '')).normalize('NFKC').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
    return (safe || 'repo').slice(0, 128)
}

const identityFor = (repoRoot) => repositoryRecord(repoRoot, graphHomeDir())
    || registerRepository({repoPath: repoRoot, graphDir: graphOutDirForRepo(repoRoot), graphHome: graphHomeDir()})

// Produces the exact source-free wire material locally. It reads no credentials and performs no
// network I/O; the caller owns destination policy, consent, authentication and transport.
export async function createSourceFreeSyncMaterial(graph, {payloadVersion = 3} = {}, ctx = {}) {
    if (!graph) throw new Error('No graph loaded — build one first (open_repo / rebuild_graph).')
    if (!ctx.graphPath || !ctx.repoRoot) throw new Error('No active repository graph — open_repo first.')
    const size = statSync(ctx.graphPath).size
    if (size > MAX_GRAPH_FILE_BYTES) throw new Error(`graph.json exceeds the ${MAX_GRAPH_FILE_BYTES / 1024 / 1024} MB local safety limit`)
    const raw = JSON.parse(readFileSync(ctx.graphPath, 'utf8'))
    let payload
    if (Number(payloadVersion) === 2) {
        payload = createSyncPayload(raw)
    } else {
        if (graphStaleness(ctx).stale) throw new Error('Cannot produce synchronized evidence from a stale graph. Run rebuild_graph first.')
        payload = createSyncPayloadV3(raw, await createEvidenceSnapshot({repoRoot: ctx.repoRoot, graph: raw}))
    }
    const body = JSON.stringify(payload)
    const bodyBytes = Buffer.byteLength(body)
    if (bodyBytes > MAX_SYNC_BODY_BYTES) throw new Error(`source-free payload exceeds the ${MAX_SYNC_BODY_BYTES / 1024} KB safety limit`)
    const identity = identityFor(ctx.repoRoot)
    return Object.freeze({
        payload,
        body,
        bodyBytes,
        bodyHash: createHash('sha256').update(body).digest('hex'),
        repoName: repositoryLabel(ctx.repoRoot),
        repositoryId: identity.repositoryId,
        graphPath: ctx.graphPath,
    })
}

export function activeRepositoryIdentity(ctx = {}) {
    if (!ctx.repoRoot || !ctx.graphPath) throw new Error('No active repository graph — open_repo first.')
    const identity = identityFor(ctx.repoRoot)
    return Object.freeze({repositoryId: identity.repositoryId, repoName: repositoryLabel(ctx.repoRoot), graphPath: ctx.graphPath})
}

export const cacheArchitectureContract = (graphPath, contract) => writeCachedArchitectureContract(graphPath, contract)

export function installedPackageCoordinates(repoRoot) {
    if (!repoRoot) throw new Error('No repository root is active.')
    return collectInstalled(repoRoot).installed
}

export const advisoryCacheMetadata = (storePath = DEFAULT_STORE) => ({
    path: storePath,
    ...storeMeta(storePath),
})

export {commitAdvisoryRefresh, createAdvisoryQueryPlan}
export {toolResult}
