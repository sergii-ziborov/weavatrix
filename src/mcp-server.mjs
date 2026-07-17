// weavatrix MCP server — the stdio entry point. The tool implementations live in src/mcp/*:
//   graph-context.mjs  — graph load + indexes, node resolution, staleness, raw-graph cache, diffs
//   tools-graph.mjs    — graph query tools        tools-impact.mjs  — dependents / diff / change impact
//   tools-health.mjs   — audit / clones / coverage / endpoints
//   tools-actions.mjs  — rebuild / open_repo / list_known_repos + the 'online' group
//   catalog.mjs        — tool catalog, capability filter, hot-reload loader
// Spawned by Claude Code / Codex as a plain Node child (node mcp-server.mjs <graph.json> <repoRoot>).
// Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
//
// .mjs on purpose: guarantees ESM parsing regardless of the nearest package.json. Runtime analyzers
// resolve only dependencies bundled with Weavatrix: web-tree-sitter grammars for graph builds and the
// pinned TypeScript language server for bounded JS/TS semantic evidence. Repository packages/scripts
// are never executed to provide either analyzer.
//
// STDOUT is the protocol channel — nothing but JSON-RPC frames may be written there. All diagnostics
// go to stderr. Two argv forms:
//   weavatrix-mcp <repoRoot> [caps]               — graph path derived from the standard layout
//   weavatrix-mcp <graph.json> <repoRoot> [caps]  — explicit graph file (classic form)
import {existsSync, statSync, realpathSync} from 'node:fs'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import process from 'node:process'
import {loadGraph} from './mcp/graph-context.mjs'
import {graphOutDirForRepo} from './graph/layout.js'
import {createRequire} from 'node:module'
import {createStalenessNoticeGate} from './mcp/staleness-notice.mjs'
import {normalizeToolResult} from './mcp/tool-result.mjs'
import {buildGraphForRepo, defaultPrecisionMode} from './build-graph.js'
import {persistedFreshnessMatches, repositoryFreshnessProbe} from './graph/freshness-probe.js'
import {activeLspClientCount, beginLspClientShutdown, shutdownActiveLspClients} from './precision/lsp-client.js'
import {PRECISION_OVERLAY_V, precisionSemanticInputsMatch, readPrecisionOverlay} from './precision/lsp-overlay.js'

// version comes from package.json so serverInfo can never drift from the published package again
const PKG_VERSION = (() => { try { return createRequire(import.meta.url)('../package.json').version } catch { return '0.0.0' } })()
const SERVER_INFO = {name: 'weavatrix', version: PKG_VERSION}
const DEFAULT_PROTOCOL = '2024-11-05'
const log = (...a) => process.stderr.write(`[weavatrix] ${a.join(' ')}\n`)

async function settleWithin(promise, timeoutMs) {
    let timer
    const settled = await Promise.race([
        Promise.resolve(promise).then(() => true, () => true),
        new Promise((resolveSettled) => { timer = setTimeout(() => resolveSettled(false), timeoutMs) }),
    ])
    if (timer) clearTimeout(timer)
    return settled
}

// argv[2] is a repo DIRECTORY in the npx form — derive the graph location from the standard layout;
// otherwise it is the graph.json path and the repo root follows it.
let GRAPH_PATH = process.argv[2]
let repoArg = process.argv[3]
// caps ABSENT (undefined) = offline defaults (explicit local retargeting, no network).
// PRESENT (even the empty string) = explicit set — see catalog.loadHotApi.
let CAPS_ARG = process.argv[4]
try {
    if (GRAPH_PATH && statSync(GRAPH_PATH).isDirectory()) {
        repoArg = realpathSync.native(GRAPH_PATH)
        CAPS_ARG = process.argv[3]
        GRAPH_PATH = join(graphOutDirForRepo(repoArg), 'graph.json')
        if (!existsSync(GRAPH_PATH)) log(`no graph built yet for ${repoArg} — ask the agent to call rebuild_graph; it builds into the standard weavatrix-graphs layout`)
    }
} catch { /* argv[2] is not a directory → classic <graph.json> <repoRoot> form */ }
// repo source root for search_code / read_source; null → those tools degrade.
let REPO_ROOT = null
try { if (repoArg && statSync(repoArg).isDirectory()) REPO_ROOT = realpathSync.native(repoArg) } catch { /* invalid repo root */ }

// ---- hot reload of tool implementations -----------------------------------------------------------
// Node caches modules at spawn, so edits to the tool code would otherwise be invisible until the MCP
// client reconnects. Before each tools/list|call we stat the hot-reloadable files (HOT_FILES); when
// any changed on disk we re-import them through catalog.loadHotApi with a cache-busting version and
// swap the tool table, then notify the client. The stdio shell, graph-context (its caches), and the
// analysis engines are NOT swapped — changing those still needs a reconnect.
const MCP_DIR = join(dirname(fileURLToPath(import.meta.url)), 'mcp')
const CATALOG_URL = new URL('./mcp/catalog.mjs', import.meta.url)
const loadCatalog = (version = 0) => import(version ? `${CATALOG_URL.href}?v=${version}` : CATALOG_URL.href)
function hotVersion(hotFiles) {
    let v = 0
    for (const f of hotFiles) {
        try { const t = statSync(join(MCP_DIR, f)).mtimeMs; if (t > v) v = t } catch { /* missing file just doesn't bump the version */ }
    }
    return v
}

async function main() {
    let catalog = await loadCatalog()
    let api = await catalog.loadHotApi(0, CAPS_ARG)
    let graph = null
    let graphError = null
    // ctx owns the CURRENT target: rebuild_graph reloads it, open_repo retargets graphPath/repoRoot
    // at runtime. loadInto always reads ctx.graphPath so both paths share one loader.
    const ctx = {graphPath: GRAPH_PATH, repoRoot: REPO_ROOT, reload: null}
    const loadInto = () => { graph = loadGraph(ctx.graphPath, {repoRoot: ctx.repoRoot}); graphError = null; return graph }
    ctx.reload = () => { api.resetStalenessCache(); try { return loadInto() } catch (e) { graphError = e.message; return null } }
    try {
        if (!ctx.graphPath) throw new Error('no graph.json path given (argv[2])')
        loadInto()
        log(`loaded ${graph.nodes.length} nodes / ${graph.links.length} edges from ${ctx.graphPath}`)
    } catch (e) {
        graphError = e.message
        log(`failed to load graph: ${e.message}`)
    }
    log(`repo root: ${REPO_ROOT || '(none — source/action tools disabled)'}`)
    log(`capabilities: ${[...api.caps].join(',') || '(none)'} (${api.tools.length} tools)`)

    let protocolVersion = DEFAULT_PROTOCOL
    const staleNotices = createStalenessNoticeGate()
    // Only build/retarget tools mutate the process-wide graph target. Serialize those mutations while
    // ordinary tools use a per-call graph/context snapshot, so an explicitly retargetable registration
    // cannot mix one repo's in-memory graph with another repo's source root under concurrent MCP calls.
    let targetMutation = Promise.resolve()
    let shuttingDown = false
    let shutdownPromise = null
    const refreshProbeCache = new Map()
    const configuredDebounce = process.env.WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS == null
        ? 2_000
        : Number(process.env.WEAVATRIX_AUTO_REFRESH_DEBOUNCE_MS)
    const refreshDebounceMs = Math.max(0, Math.min(5_000, Number.isFinite(configuredDebounce) ? configuredDebounce : 2_000))
    const autoRefresh = async (callCtx, currentGraph) => {
        if (!callCtx?.repoRoot || !callCtx?.graphPath) return {graph: null, refresh: null}
        const activePrecision = currentGraph?.graphPrecisionMode || defaultPrecisionMode()
        const probeKey = `${callCtx.graphPath}\0${currentGraph?.graphBuildMode || 'full'}\0${activePrecision}`
        // Semantic inputs include ignored configs and configured project files that Git status does
        // not see. Check their bounded fingerprint before the ordinary source freshness debounce;
        // exact evidence must have no stale window, even on back-to-back tool calls.
        let semanticInputsChanged = false
        if (activePrecision === 'lsp' && currentGraph) {
            try {
                const overlay = readPrecisionOverlay(callCtx.graphPath, currentGraph)
                semanticInputsChanged = typeof overlay?.semanticInputFingerprint === 'string'
                    && !precisionSemanticInputsMatch(overlay, callCtx.repoRoot, currentGraph)
            } catch {
                semanticInputsChanged = true
            }
        }
        const cachedProbe = refreshProbeCache.get(probeKey)
        if (!semanticInputsChanged && currentGraph && cachedProbe && Date.now() - cachedProbe.checkedAt < refreshDebounceMs) {
            return {graph: currentGraph, refresh: {kind: 'none', revision: currentGraph.graphRevision || null, changedFiles: 0}}
        }
        const beforeProbe = repositoryFreshnessProbe(callCtx.repoRoot)
        const precisionMissing = activePrecision === 'lsp' && (
            Number(currentGraph?.precisionOverlayV) !== PRECISION_OVERLAY_V
            || semanticInputsChanged
        )
        if (!precisionMissing && beforeProbe && currentGraph && (
            cachedProbe?.probe === beforeProbe
            || persistedFreshnessMatches(currentGraph, beforeProbe, currentGraph.graphBuildMode || 'full')
        )) {
            refreshProbeCache.set(probeKey, {probe: beforeProbe, checkedAt: Date.now()})
            return {graph: currentGraph, refresh: {kind: 'none', revision: currentGraph.graphRevision || null, changedFiles: 0}}
        }
        const result = await buildGraphForRepo(callCtx.repoRoot, {
            mode: currentGraph?.graphBuildMode || 'full',
            precision: activePrecision,
            scope: '',
            outDir: dirname(callCtx.graphPath),
        })
        if (!result.ok) throw new Error(result.error || 'automatic graph refresh failed')
        api.resetStalenessCache()
        const fresh = loadGraph(callCtx.graphPath, {repoRoot: callCtx.repoRoot})
        const afterProbe = repositoryFreshnessProbe(callCtx.repoRoot)
        if (afterProbe && afterProbe === beforeProbe) refreshProbeCache.set(probeKey, {probe: afterProbe, checkedAt: Date.now()})
        else refreshProbeCache.delete(probeKey)
        const update = result.refresh || {kind: 'full', changedFiles: [], reason: 'automatic-refresh'}
        return {
            graph: fresh,
            refresh: {
                kind: update.kind,
                revision: update.revision || fresh.graphRevision || null,
                changedFiles: Array.isArray(update.changedFiles) ? update.changedFiles.length : 0,
                notice: update.kind === 'none' ? undefined : `Graph ${update.kind === 'incremental' ? 'incrementally refreshed' : 'rebuilt'} before this answer (${update.reason || 'repository changed'}).`,
            },
        }
    }
    const send = (msg) => {
        // A request that was already running when the client disconnected may complete during the
        // bounded drain. Do not write a late reply into a closed protocol pipe.
        if (shuttingDown || process.stdout.destroyed || !process.stdout.writable) return false
        try {
            return process.stdout.write(JSON.stringify(msg) + '\n')
        } catch (error) {
            if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') return false
            throw error
        }
    }
    const reply = (id, result) => send({jsonrpc: '2.0', id, result})
    const fail = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}})

    const requestShutdown = (reason, exitCode = 0) => {
        if (shutdownPromise) return shutdownPromise
        shuttingDown = true
        // This is synchronous and deliberately precedes every await: a graph build that reaches its
        // precision phase during the drain must not create a fresh TLS/tsserver process tree.
        beginLspClientShutdown()
        process.stdin.pause()
        const activeAtStart = activeLspClientCount()
        log(`shutdown requested (${reason}); draining graph work and ${activeAtStart} semantic provider(s)`)
        shutdownPromise = (async () => {
            // Give an ordinary auto-refresh a chance to commit and close its provider itself. A wedged
            // parse/query is bounded; active semantic children are then closed or tree-killed, after
            // which the mutation gets a final window to observe that cancellation and release locks.
            const initiallyDrained = await settleWithin(targetMutation, 2_500)
            const semantic = await shutdownActiveLspClients({timeoutMs: 3_000})
            const fullyDrained = initiallyDrained || await settleWithin(targetMutation, 1_500)
            log(`shutdown cleanup: graph=${fullyDrained ? 'drained' : 'bounded-timeout'}, semantic=${semantic.requested} requested/${semantic.remaining} remaining${semantic.timedOut ? ' (forced)' : ''}`)
        })().catch((error) => {
            log(`shutdown cleanup failed: ${error.stack || error.message}`)
        }).finally(() => {
            process.exit(exitCode)
        })
        return shutdownPromise
    }
    process.stdout.on('error', (error) => {
        if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') {
            void requestShutdown('stdout disconnected')
            return
        }
        log(`stdout error: ${error.stack || error.message}`)
        void requestShutdown('stdout error', 1)
    })

    let loadedVersion = hotVersion(catalog.HOT_FILES)
    let lastFailedVersion = 0
    const maybeHotReload = async () => {
        const v = hotVersion(catalog.HOT_FILES)
        if (v <= loadedVersion || v === lastFailedVersion) return
        try {
            const nextCatalog = await loadCatalog(v)
            const nextApi = await nextCatalog.loadHotApi(v, CAPS_ARG)
            catalog = nextCatalog
            api = nextApi
            loadedVersion = v
            log(`hot-reloaded tool implementations from changed source (${api.tools.length} tools)`)
            send({jsonrpc: '2.0', method: 'notifications/tools/list_changed'})
        } catch (e) {
            lastFailedVersion = v // remember the broken version so we don't retry it every call
            log(`hot-reload failed, keeping current tools: ${e.message}`)
        }
    }

    const handle = async (msg) => {
        const {id, method, params} = msg
        const isNotification = id === undefined || id === null
        if (shuttingDown) {
            if (!isNotification) fail(id, -32000, 'MCP server is shutting down')
            return
        }
        if (method === 'initialize') {
            if (params?.protocolVersion) protocolVersion = String(params.protocolVersion)
            return reply(id, {protocolVersion, capabilities: {tools: {listChanged: true}}, serverInfo: SERVER_INFO})
        }
        if (method === 'notifications/initialized' || method === 'initialized') return
        if (method === 'ping') return reply(id, {})
        if (method === 'tools/list') {
            await maybeHotReload()
            if (shuttingDown) return
            return reply(id, {tools: api.tools.map(({name, description, inputSchema, outputSchema}) => ({name, description, inputSchema, outputSchema}))})
        }
        if (method === 'tools/call') {
            await maybeHotReload()
            // EOF can arrive while the hot-reload import is pending. Do not enqueue a graph mutation
            // after requestShutdown captured the mutation chain it is responsible for draining.
            if (shuttingDown) return
            const tool = api.byName.get(params?.name)
            if (!tool) return reply(id, {content: [{type: 'text', text: `Unknown tool: ${params?.name}`}], isError: true})
            const refreshesGraph = tool.cap === 'graph' || tool.cap === 'health' || tool.refreshGraph === true
            // Graph/health reads can establish a missing graph automatically when a repo root is known.
            if (!graph && !refreshesGraph && tool.cap !== 'build' && tool.cap !== 'retarget') return reply(id, {content: [{type: 'text', text: `Graph unavailable: ${graphError}`}], isError: true})
            const mutatesTarget = tool.cap === 'build' || tool.cap === 'retarget'
            const graphSnapshot = graph
            const callCtx = mutatesTarget ? ctx : {...ctx}
            const execute = async () => {
                try {
                    // A queued rebuild must see a preceding retarget's graph, while non-mutating calls stay
                    // pinned to the graph that was active when their request arrived.
                    let refresh = null
                    let callGraph = mutatesTarget ? graph : graphSnapshot
                    if (!mutatesTarget && refreshesGraph) {
                        const refreshed = await autoRefresh(callCtx, callGraph)
                        if (refreshed.graph) {
                            callGraph = refreshed.graph
                            refresh = refreshed.refresh
                            if (ctx.graphPath === callCtx.graphPath && ctx.repoRoot === callCtx.repoRoot) graph = callGraph
                        }
                    }
                    const toolArgs = params?.arguments || {}
                    const value = await tool.run(callGraph, toolArgs, callCtx)
                    const warnings = []
                    if (callGraph && callGraph.edgeTypesV < 2 && (tool.cap === 'graph' || tool.cap === 'health')) {
                        warnings.push({code: 'EDGE_SCHEMA_OUTDATED', message: 'This saved graph predates compile-only edge metadata (edge schema v2); rebuild before acting on cycle, boundary, dependency, or blast-radius findings.'})
                    }
                    // Graph answers silently reflect a point-in-time build — surface staleness on every graph tool.
                    const staleLine = tool.cap === 'graph' ? api.stalenessLine(callCtx) : null
                    if (staleLine) warnings.push({code: 'GRAPH_STALE', message: staleLine})
                    const normalized = normalizeToolResult({
                        toolName: tool.name, value, args: toolArgs, ctx: callCtx, warnings, refresh,
                        freshness: staleLine ? 'stale' : 'fresh',
                    })
                    let text = normalized.text
                    if (toolArgs.output_format !== 'json') {
                        const schemaWarning = warnings.find((warning) => warning.code === 'EDGE_SCHEMA_OUTDATED')
                        if (schemaWarning) text += `\n\nWarning: ${schemaWarning.message}`
                        if (staleLine && staleNotices.shouldShow({line: staleLine, graphPath: callCtx.graphPath, force: tool.name === 'graph_stats'})) text += `\n\n${staleLine}`
                    }
                    const response = {content: [{type: 'text', text}]}
                    if (normalized.structured) response.structuredContent = normalized.structured
                    return reply(id, response)
                } catch (e) {
                    log(`tool ${params?.name} threw: ${e.stack || e.message}`)
                    return reply(id, {content: [{type: 'text', text: `Tool error: ${e.message}`}], isError: true})
                }
            }
            if (!mutatesTarget && !refreshesGraph) return execute()
            const pending = targetMutation.then(execute, execute)
            targetMutation = pending.catch(() => {})
            return pending
        }
        if (!isNotification) return fail(id, -32601, `Method not found: ${method}`)
    }

    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
        if (shuttingDown) return
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) continue
            let msg
            try {
                msg = JSON.parse(line)
            } catch {
                log(`bad JSON line: ${line.slice(0, 120)}`)
                continue
            }
            // handle is async (rebuild_graph awaits a build) → catch rejections, not just sync throws
            Promise.resolve().then(() => handle(msg)).catch((e) => {
                log(`handler error: ${e.stack || e.message}`)
                if (msg?.id != null) fail(msg.id, -32603, `Internal error: ${e.message}`)
            })
        }
    })
    process.stdin.on('end', () => { void requestShutdown('stdin EOF') })
    process.on('SIGTERM', () => { void requestShutdown('SIGTERM') })
    process.on('SIGINT', () => { void requestShutdown('SIGINT') })
    log('ready')
}

// Guard: hot-reload re-imports of tool modules never touch this entry, but keep the start guard so a
// stray re-import of the entry itself can never spawn a second stdio loop.
if (!globalThis.__weavatrixMcpStarted) {
    globalThis.__weavatrixMcpStarted = true
    main()
}
