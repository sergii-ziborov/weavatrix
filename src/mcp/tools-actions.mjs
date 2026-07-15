// Action tools: rebuild the graph, retarget the server at another repo, list sibling repos with
// built graphs — plus the 'online' capability group (the ONLY tools that ever touch the network).
// Hot-reloadable (re-imported by catalog.mjs on change).
import {readFileSync, writeFileSync, existsSync, readdirSync, statSync} from 'node:fs'
import {join, dirname} from 'node:path'
import {prevGraphPathFor, diffGraphs, formatGraphDiff} from './graph-context.mjs'
import {buildGraphForRepo} from '../build-graph.js'
import {graphOutDirForRepo} from '../graph/layout.js'
import {refreshAdvisories, storeMeta, DEFAULT_STORE} from '../security/advisory-store.js'
import {collectInstalled} from '../security/installed.js'

export async function tRebuildGraph(g, args, ctx) {
    if (!ctx.repoRoot) return 'Rebuild needs the repo root (not provided to this server).'
    const mode = ['no-tests', 'tests-only', 'full'].includes(args.mode) ? args.mode : 'full'
    // snapshot the outgoing state: bytes → graph.prev.json (for graph_diff later), struct → inline delta
    let prevBytes = null
    try { prevBytes = readFileSync(ctx.graphPath) } catch { /* first build — nothing to diff against */ }
    const before = g?.nodes ? {nodes: g.nodes, links: g.links} : null
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
    const repoPath = String(args.path || '').trim().replace(/[\\/]+$/, '')
    if (!repoPath) return 'Provide "path" — an absolute path to a local repository folder.'
    if (!existsSync(repoPath)) return `Path not found: ${repoPath}`
    const graphPath = join(graphOutDirForRepo(repoPath), 'graph.json')
    let built = false
    if (!existsSync(graphPath)) {
        if (args.build === false) return `No graph yet for ${repoPath} (expected at ${graphPath}). Re-call without build:false to build one — large repos can take minutes.`
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
    return `Opened ${repoPath}${built ? ' (graph built fresh)' : ''}: ${loaded.nodes.length} nodes / ${loaded.links.length} edges. All tools now target this repo.`
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
        `Advisory store refreshed from OSV.dev: ${res.queried} package versions queried, ${res.vulnerable} with known advisories (${res.fetched} advisory records fetched).`,
        res.unsupported ? `${res.unsupported} packages skipped (ecosystem not OSV-queryable — npm/PyPI/Go only).` : null,
        res.errors?.length ? `Partial: ${res.errors.length} request error(s), first: ${res.errors[0]}` : null,
        `Store: ${DEFAULT_STORE} (${meta.advisoryCount} advisories, fetched ${meta.fetchedAt}). run_audit now reflects it — offline.`,
    ].filter(Boolean).join('\n')
}

// Push the current graph.json to a user-configured endpoint (the weavatrix site's hosted graph view,
// or any self-hosted collector). Off until WEAVATRIX_SYNC_URL is set. The payload is the graph only —
// file paths, symbol names, and edges — never file contents.
export async function tSyncGraph(g, args, ctx) {
    const url = process.env.WEAVATRIX_SYNC_URL
    if (!url) {
        return 'Graph sync is not configured (optional feature). Set WEAVATRIX_SYNC_URL to the upload endpoint'
            + ' (and WEAVATRIX_SYNC_TOKEN for bearer auth) in the MCP registration env, then call again.'
    }
    if (!g) return 'No graph loaded — build one first (open_repo / rebuild_graph).'
    let body
    try { body = readFileSync(ctx.graphPath, 'utf8') } catch (e) { return `Cannot read ${ctx.graphPath}: ${e.message}` }
    const repoName = String(ctx.repoRoot || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo'
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-weavatrix-repo': repoName,
                ...(process.env.WEAVATRIX_SYNC_TOKEN ? {authorization: `Bearer ${process.env.WEAVATRIX_SYNC_TOKEN}`} : {}),
            },
            body,
        })
        if (!res.ok) return `Sync endpoint answered HTTP ${res.status} — graph NOT accepted.`
        return `Graph for ${repoName} (${g.nodes.length} nodes / ${g.links.length} edges, ${Math.round(body.length / 1024)} KB) pushed to ${url}.`
    } catch (e) {
        return `Sync failed: ${e.message} — the graph stays local.`
    }
}
