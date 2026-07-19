import {createHash} from 'node:crypto'
import {readFileSync, statSync} from 'node:fs'
import {graphStaleness} from '../graph-context.mjs'
import {graphHomeDir, graphOutDirForRepo} from '../../graph/layout.js'
import {registerRepository, repositoryRecord} from '../../graph/repo-registry.js'
import {createSyncPayload, createSyncPayloadV3, MAX_SYNC_BODY_BYTES} from '../sync-payload.mjs'
import {createEvidenceSnapshot} from '../evidence-snapshot.mjs'
import {toolResult} from '../tool-result.mjs'

const MAX_SYNC_GRAPH_FILE_BYTES = 64 * 1024 * 1024
const SYNC_PREVIEW_TTL_MS = 5 * 60 * 1000
const MAX_SYNC_PREVIEWS = 4
const syncPreviews = new Map()

function syncRepoLabel(repoRoot) {
    const basename = String(repoRoot || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo'
    const safe = basename.normalize('NFKC').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
    return (safe || 'repo').slice(0, 128)
}

export function syncDestination(raw) {
    let url
    try { url = new URL(raw) } catch { throw new Error('WEAVATRIX_SYNC_URL is invalid') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('WEAVATRIX_SYNC_URL must use HTTPS (or HTTP for loopback development)')
    if (url.username || url.password) throw new Error('WEAVATRIX_SYNC_URL must not contain embedded credentials; use WEAVATRIX_SYNC_TOKEN')
    if (url.hash) throw new Error('WEAVATRIX_SYNC_URL must not contain a fragment')
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())
    if (url.protocol !== 'https:' && !loopback) throw new Error('WEAVATRIX_SYNC_URL must use HTTPS unless the destination is loopback')
    const display = `${url.origin}${url.pathname}${url.search ? ' (query redacted)' : ''}`
    return {url: url.toString(), display}
}

function pruneSyncPreviews(now = Date.now()) {
    for (const [token, preview] of syncPreviews) if (preview.expiresAt <= now) syncPreviews.delete(token)
    while (syncPreviews.size >= MAX_SYNC_PREVIEWS) syncPreviews.delete(syncPreviews.keys().next().value)
}

function confirmationToken({url, repositoryId, payloadVersion, bodyHash}) {
    return createHash('sha256')
        .update(`weavatrix-sync-preview-v1\0${url}\0${repositoryId}\0${payloadVersion}\0${bodyHash}`)
        .digest('hex').slice(0, 24)
}

function syncSectionSummary(payload) {
    if (payload.syncPayloadV !== 3) return 'graph topology only (explicit V2 compatibility mode)'
    const sections = payload.evidence?.sections || {}
    const names = Object.entries(sections).map(([name, section]) => `${name}:${section?.state || section?.verdict || 'included'}`)
    return names.join(', ') || 'bounded architecture/health/stack/package/duplicate evidence'
}

function syncPreviewText(preview, {expired = false} = {}) {
    return [
        `SYNC PREVIEW${expired ? ' (the supplied confirmation was missing, expired, or did not match)' : ''} — no network request was made.`,
        `Destination: ${preview.destinationDisplay}.`,
        `Repository: ${preview.repoName}; opaque repository UUID: ${preview.repositoryId}.`,
        `Payload V${preview.payload.syncPayloadV}: ${preview.payload.nodes.length} nodes / ${preview.payload.links.length} edges, ${Math.round(preview.bodyBytes / 1024)} KB; body SHA-256 ${preview.bodyHash.slice(0, 12)}.`,
        `Payload fields: ${Object.keys(preview.payload).sort().join(', ')}.`,
        `Included sections: ${syncSectionSummary(preview.payload)}.`,
        'Excluded by the wire allowlist: source bodies, snippets, absolute host paths, environment values, credentials, Git remotes, and unknown fields.',
        `After the user approves this exact destination and summary, call sync_graph again within 5 minutes with dry_run:false and confirm_token: "${preview.token}".`,
    ].join('\n')
}

async function sendSyncPreview(preview, timeoutMs) {
    try {
        const res = await fetch(preview.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-weavatrix-payload-version': String(preview.payload.syncPayloadV),
                'x-weavatrix-repo': preview.repoName,
                'x-weavatrix-repository-id': preview.repositoryId,
                ...(process.env.WEAVATRIX_SYNC_TOKEN ? {authorization: `Bearer ${process.env.WEAVATRIX_SYNC_TOKEN}`} : {}),
            },
            body: preview.body,
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
            const accepted = res.headers?.get?.('x-weavatrix-accept-payload-versions')
            const compatibility = (res.status === 415 || res.status === 422) && accepted
                ? ` Endpoint accepts payload version(s) ${accepted}; create and approve a new V2 preview only if graph-only sync is intentional.`
                : ''
            return `Sync endpoint ${preview.destinationDisplay} answered HTTP ${res.status} — graph NOT accepted.${compatibility}`
        }
        syncPreviews.delete(preview.token)
        const evidenceNote = preview.payload.syncPayloadV === 3
            ? ` + evidence ${preview.payload.evidence?.snapshotHash?.slice(0, 12) || 'unknown'}`
            : ''
        return `Graph for ${preview.repoName} (${preview.payload.nodes.length} nodes / ${preview.payload.links.length} edges${evidenceNote}, ${Math.round(preview.bodyBytes / 1024)} KB) pushed to approved destination ${preview.destinationDisplay}.`
    } catch (error) {
        return `Sync failed: ${error.message} — the graph stays local; the approved preview remains retryable until it expires.`
    }
}

async function buildSyncPreview(g, args, ctx) {
    const configuredUrl = process.env.WEAVATRIX_SYNC_URL
    if (!configuredUrl) {
        return 'Graph sync is not configured (optional feature). Set WEAVATRIX_SYNC_URL to the upload endpoint'
            + ' (and WEAVATRIX_SYNC_TOKEN for bearer auth) in the MCP registration env, then call again.'
    }
    let destination
    try { destination = syncDestination(configuredUrl) }
    catch (error) { return `Graph sync is not configured safely: ${error.message}.` }
    if (!g) return 'No graph loaded — build one first (open_repo / rebuild_graph).'
    let raw
    try {
        const size = statSync(ctx.graphPath).size
        if (size > MAX_SYNC_GRAPH_FILE_BYTES) {
            return `Cannot sync: graph.json is ${Math.ceil(size / 1024 / 1024)} MB; the local safety limit is ${MAX_SYNC_GRAPH_FILE_BYTES / 1024 / 1024} MB.`
        }
        raw = JSON.parse(readFileSync(ctx.graphPath, 'utf8'))
    } catch (e) { return `Cannot read ${ctx.graphPath}: ${e.message}` }
    const requestedVersion = Number(args.payload_version) === 2 ? 2 : 3
    let payload
    try {
        if (requestedVersion === 2) {
            payload = createSyncPayload(raw)
        } else {
            if (!ctx.repoRoot) return 'Cannot build evidence: no repository root is active.'
            if (graphStaleness(ctx).stale) {
                return 'Cannot sync evidence from a stale graph. Run rebuild_graph, then call sync_graph again.'
            }
            const evidence = await createEvidenceSnapshot({repoRoot: ctx.repoRoot, graph: raw})
            payload = createSyncPayloadV3(raw, evidence)
        }
    } catch (e) {
        return `Cannot sync: ${e.message}. Run rebuild_graph once before sync_graph.`
    }
    const body = JSON.stringify(payload)
    const bodyBytes = Buffer.byteLength(body)
    if (bodyBytes > MAX_SYNC_BODY_BYTES) {
        return `Cannot sync: payload is ${Math.ceil(bodyBytes / 1024)} KB; the hosted safety limit is ${MAX_SYNC_BODY_BYTES / 1024} KB. Narrow the graph scope and rebuild before retrying.`
    }
    const repoName = syncRepoLabel(ctx.repoRoot)
    const registry = repositoryRecord(ctx.repoRoot, graphHomeDir())
        || registerRepository({repoPath: ctx.repoRoot, graphDir: graphOutDirForRepo(ctx.repoRoot), graphHome: graphHomeDir()})
    const bodyHash = createHash('sha256').update(body).digest('hex')
    const token = confirmationToken({url: destination.url, repositoryId: registry.repositoryId, payloadVersion: payload.syncPayloadV, bodyHash})
    const preview = {
        token, url: destination.url, destinationDisplay: destination.display,
        graphPath: ctx.graphPath, repoName, repositoryId: registry.repositoryId,
        payload, body, bodyBytes, bodyHash, expiresAt: Date.now() + SYNC_PREVIEW_TTL_MS,
    }
    syncPreviews.set(token, preview)
    return preview
}

function previewResult(preview, {expired = false} = {}) {
    if (typeof preview === 'string') return preview
    return toolResult(syncPreviewText(preview, {expired}), {
        status: 'PREVIEW_READY', networkRequestMade: false,
        destination: preview.destinationDisplay, repository: preview.repoName,
        repositoryId: preview.repositoryId, payloadVersion: preview.payload.syncPayloadV,
        nodes: preview.payload.nodes.length, links: preview.payload.links.length,
        bodyBytes: preview.bodyBytes, bodyHash: preview.bodyHash,
        payloadFields: Object.keys(preview.payload).sort(), sections: syncSectionSummary(preview.payload),
        expiresAt: new Date(preview.expiresAt).toISOString(), confirmToken: preview.token,
    }, {completeness: {status: 'COMPLETE', reason: 'exact allowlisted payload serialized locally; no network request made'}})
}

// Build the exact upload body and approval token without any network request. Kept separate from the
// mutating tool so safety layers and humans can approve a local preview without authorizing egress.
export async function tPreviewSyncGraph(g, args, ctx) {
    pruneSyncPreviews()
    return previewResult(await buildSyncPreview(g, args, ctx))
}

// Push the exact payload previously approved through preview_sync. The old dry_run form remains a
// compatibility alias for one release, but can never send unless dry_run:false and the token matches.
export async function tSyncGraph(g, args, ctx) {
    if (args.dry_run !== false) {
        pruneSyncPreviews()
        const preview = await buildSyncPreview(g, args, ctx)
        if (typeof preview === 'string') return preview
        const suppliedToken = String(args.confirm_token || '').trim()
        const exact = suppliedToken && suppliedToken === preview.token
        return `${syncPreviewText(preview, {expired: !!suppliedToken && !exact})}${exact ? '\nConfirmation token recognized, but dry_run is still true; no network request was made.' : ''}`
    }
    const configuredUrl = process.env.WEAVATRIX_SYNC_URL
    if (!configuredUrl) return 'Graph sync is not configured (optional feature). Set WEAVATRIX_SYNC_URL first.'
    let destination
    try { destination = syncDestination(configuredUrl) }
    catch (error) { return `Graph sync is not configured safely: ${error.message}.` }
    pruneSyncPreviews()
    const suppliedToken = String(args.confirm_token || '').trim()
    const approved = suppliedToken ? syncPreviews.get(suppliedToken) : null
    if (approved && approved.expiresAt > Date.now()
        && approved.url === destination.url && approved.graphPath === ctx.graphPath) {
        const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeout_ms) || 30000))
        return sendSyncPreview(approved, timeoutMs)
    }
    const preview = await buildSyncPreview(g, args, ctx)
    return typeof preview === 'string' ? preview : syncPreviewText(preview, {expired: true})
}

