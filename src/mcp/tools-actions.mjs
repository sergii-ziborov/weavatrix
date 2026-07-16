// Action tools: rebuild the graph, the explicit 'retarget' group, and the explicit 'online' group
// (the ONLY tools that ever touch the network).
// Hot-reloadable (re-imported by catalog.mjs on change).
import {readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync} from 'node:fs'
import {join, dirname, isAbsolute} from 'node:path'
import {prevGraphPathFor, diffGraphs, formatGraphDiff, graphStaleness} from './graph-context.mjs'
import {buildGraphForRepo} from '../build-graph.js'
import {graphOutDirForRepo} from '../graph/layout.js'
import {refreshAdvisories, storeMeta, DEFAULT_STORE} from '../security/advisory-store.js'
import {collectInstalled} from '../security/installed.js'
import {createSyncPayload, createSyncPayloadV3, MAX_SYNC_BODY_BYTES} from './sync-payload.mjs'
import {createEvidenceSnapshot} from './evidence-snapshot.mjs'

const MAX_SYNC_GRAPH_FILE_BYTES = 64 * 1024 * 1024

function syncRepoLabel(repoRoot) {
    const basename = String(repoRoot || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo'
    const safe = basename.normalize('NFKC').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
    return (safe || 'repo').slice(0, 128)
}

export async function tRebuildGraph(g, args, ctx) {
    if (!ctx.repoRoot) return 'Rebuild needs the repo root (not provided to this server).'
    const mode = ['no-tests', 'tests-only', 'full'].includes(args.mode) ? args.mode : 'full'
    // snapshot the outgoing state: bytes → graph.prev.json (for graph_diff later), struct → inline delta
    let prevBytes = null
    try { prevBytes = readFileSync(ctx.graphPath) } catch { /* first build — nothing to diff against */ }
    const before = g?.nodes ? {nodes: g.nodes, links: g.links, edgeTypesV: g.edgeTypesV || 0} : null
    const res = await buildGraphForRepo(ctx.repoRoot, {mode, scope: args.scope || ''})
    if (!res || !res.ok) return `Graph rebuild failed: ${(res && res.error) || 'unknown error'}`
    if (prevBytes) { try { writeFileSync(prevGraphPathFor(ctx.graphPath), prevBytes) } catch { /* snapshot is best-effort */ } }
    const fresh = ctx.reload() // refresh THIS server's in-memory graph so subsequent tool calls see the new graph
    const delta = before && fresh ? formatGraphDiff(diffGraphs(before, fresh)) : null
    return [
        `Rebuilt the graph (${mode}${args.scope ? `, scope=${args.scope}` : ''}). ${res.log || ''}. In-memory graph reloaded — graph tools now reflect it.`,
        delta
    ].filter(Boolean).join('\n\n')
}

// Retarget this server at ANOTHER local repository at runtime — one weavatrix registration serves any
// repo. Loads <parent>/weavatrix-graphs/<name>/graph.json (the central layout graphs
// always live in), building it first when missing. On a failed load the previous repo stays active.
export async function tOpenRepo(g, args, ctx) {
    const requestedPath = String(args.path || '').trim()
    if (!requestedPath) return 'Provide "path" — an absolute path to a local repository folder.'
    if (!isAbsolute(requestedPath)) return 'open_repo requires an absolute repository path.'
    let repoPath
    try { repoPath = realpathSync.native(requestedPath) } catch { return `Path not found: ${requestedPath}` }
    try { if (!statSync(repoPath).isDirectory()) return `Not a directory: ${requestedPath}` } catch { return `Path not found: ${requestedPath}` }
    if (!existsSync(join(repoPath, '.git'))) return `Not a Git repository: ${requestedPath}`
    const graphPath = join(graphOutDirForRepo(repoPath), 'graph.json')
    let built = false
    let upgrade = false
    if (existsSync(graphPath)) {
        try {
            const saved = JSON.parse(readFileSync(graphPath, 'utf8'))
            upgrade = !Number.isInteger(saved.edgeTypesV) || saved.edgeTypesV < 2
        } catch {
            upgrade = true
        }
    }
    if (!existsSync(graphPath) || upgrade) {
        if (args.build === false) {
            return upgrade
                ? `The existing graph for ${repoPath} predates compile-only edge metadata (edge schema v2). Re-call without build:false to upgrade it before switching.`
                : `No graph yet for ${repoPath} (expected at ${graphPath}). Re-call without build:false to build one — large repos can take minutes.`
        }
        const mode = ['no-tests', 'tests-only', 'full'].includes(args.mode) ? args.mode : 'full'
        const res = await buildGraphForRepo(repoPath, {mode, scope: ''})
        if (!res || !res.ok) return `Graph build failed for ${repoPath}: ${(res && res.error) || 'unknown error'}`
        built = true
    }
    const prev = {graphPath: ctx.graphPath, repoRoot: ctx.repoRoot}
    ctx.graphPath = graphPath
    ctx.repoRoot = repoPath
    const loaded = ctx.reload()
    if (!loaded) {
        ctx.graphPath = prev.graphPath
        ctx.repoRoot = prev.repoRoot
        ctx.reload()
        return `Failed to load ${graphPath} — still targeting the previous repo (${prev.repoRoot || 'none'}).`
    }
    const buildNote = built ? (upgrade ? ' (graph upgraded to edge metadata v2)' : ' (graph built fresh)') : ''
    return `Opened ${repoPath}${buildNote}: ${loaded.nodes.length} nodes / ${loaded.links.length} edges. All tools now target this repo.`
}

// Sibling repos that already have a built graph in the central weavatrix-graphs folder — open_repo candidates.
export function tListKnownRepos(g, args, ctx) {
    if (!ctx.repoRoot) return 'No repo root — cannot locate the central graphs folder.'
    const parent = dirname(ctx.repoRoot)
    const root = join(parent, 'weavatrix-graphs')
    const norm = (p) => String(p).replace(/[\\/]+/g, '/').toLowerCase()
    let entries = []
    try { entries = readdirSync(root, {withFileTypes: true}) } catch { return `No central graphs folder at ${root}.` }
    const rows = []
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const graphPath = join(root, entry.name, 'graph.json')
        try {
            const st = statSync(graphPath)
            rows.push({name: entry.name, repoPath: join(parent, entry.name), builtAt: st.mtime.toISOString()})
        } catch { /* no graph built for this entry */ }
    }
    if (!rows.length) return `No built graphs under ${root}.`
    return [
        `Repos with built graphs under ${root} (switch with open_repo):`,
        ...rows.map((r) => `  ${norm(r.repoPath) === norm(ctx.repoRoot) ? '»' : ' '} ${r.name} — graph built ${r.builtAt}  (${r.repoPath})`),
    ].join('\n')
}

// ---- online tools ('online' capability group) -----------------------------------------------------
// Scans and graph queries stay 100% offline. These two run a network call ONLY when explicitly
// invoked; registering the server with a caps list that omits 'online' removes them entirely.

// Refresh the local OSV advisory store for the current repo's lockfile-pinned packages. What leaves
// the machine: package names + versions (that is what an OSV query IS) — never source code.
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

// Push the current graph.json to a user-configured endpoint. Off until WEAVATRIX_SYNC_URL is set.
// The payload is graph metadata (paths, symbols/ranges, imports, edges, metrics), never file contents.
export async function tSyncGraph(g, args, ctx) {
    const url = process.env.WEAVATRIX_SYNC_URL
    if (!url) {
        return 'Graph sync is not configured (optional feature). Set WEAVATRIX_SYNC_URL to the upload endpoint'
            + ' (and WEAVATRIX_SYNC_TOKEN for bearer auth) in the MCP registration env, then call again.'
    }
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
    const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeout_ms) || 30000))
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-weavatrix-payload-version': String(payload.syncPayloadV),
                'x-weavatrix-repo': repoName,
                ...(process.env.WEAVATRIX_SYNC_TOKEN ? {authorization: `Bearer ${process.env.WEAVATRIX_SYNC_TOKEN}`} : {}),
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
            const accepted = res.headers?.get?.('x-weavatrix-accept-payload-versions')
            const compatibility = (res.status === 415 || res.status === 422) && accepted
                ? ` Endpoint accepts payload version(s) ${accepted}; retry with payload_version:2 only if you intentionally want graph-only sync.`
                : ''
            return `Sync endpoint answered HTTP ${res.status} — graph NOT accepted.${compatibility}`
        }
        const evidenceNote = payload.syncPayloadV === 3
            ? ` + evidence ${payload.evidence?.snapshotHash?.slice(0, 12) || 'unknown'}`
            : ''
        return `Graph for ${repoName} (${payload.nodes.length} nodes / ${payload.links.length} edges${evidenceNote}, ${Math.round(bodyBytes / 1024)} KB) pushed to ${url}.`
    } catch (e) {
        return `Sync failed: ${e.message} — the graph stays local.`
    }
}
