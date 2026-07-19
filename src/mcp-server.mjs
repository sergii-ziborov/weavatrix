// Weavatrix MCP stdio entry point; implementations and extension composition live in src/mcp/*.
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
import process from 'node:process'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {loadGraph} from './mcp/graph-context.mjs'
import {createStalenessNoticeGate} from './mcp/staleness-notice.mjs'
import {normalizeToolResult} from './mcp/tool-result.mjs'
import {runtimeVersionStatus, staleRuntimeMessage} from './mcp/runtime-version.mjs'
import {createAutoRefresh} from './mcp/server/auto-refresh.mjs'
import {createShutdownController} from './mcp/server/shutdown.mjs'
import {
    hotCatalogVersion as hotVersion, loadServerCatalog as loadCatalog, PACKAGE_JSON_PATH,
    PACKAGE_VERSION as PKG_VERSION, resolveServerTarget, SERVER_INFO,
} from './mcp/server/runtime-config.mjs'

// version comes from package.json so serverInfo can never drift from the published package again
const DEFAULT_PROTOCOL = '2024-11-05'
const log = (...a) => process.stderr.write(`[weavatrix] ${a.join(' ')}\n`)

// ---- hot reload of tool implementations -----------------------------------------------------------
// Node caches modules at spawn, so edits to the tool code would otherwise be invisible until the MCP
// client reconnects. Before each tools/list|call we stat the hot-reloadable files (HOT_FILES); when
// any changed on disk we re-import them through catalog.loadHotApi with a cache-busting version and
// swap the tool table, then notify the client. The stdio shell, graph-context (its caches), and the
// analysis engines are NOT swapped — changing those still needs a reconnect.
export async function startMcpServer({
    argv = process.argv,
    defaultCapabilities,
    loadExtensions = async () => [],
    packageJsonPath = PACKAGE_JSON_PATH,
    packageVersion = PKG_VERSION,
    serverInfo = SERVER_INFO,
} = {}) {
    const target = resolveServerTarget(argv, log)
    const GRAPH_PATH = target.graphPath
    const REPO_ROOT = target.repoRoot
    const CAPS_ARG = target.capabilities ?? defaultCapabilities
    let catalog = await loadCatalog()
    let extensions = await loadExtensions({version: 0})
    let api = await catalog.loadHotApi(0, CAPS_ARG, {extensions})
    const runtimeInfo = () => ({
        ...runtimeVersionStatus({runningVersion: packageVersion, packageJsonPath}),
        profile: api.profile || 'custom',
        capabilities: [...api.caps],
        toolCount: api.tools.length,
        ...(api.extensions.items.length ? {extensions: api.extensions.items} : {}),
    })
    const runtimeInstructions = () => {
        const runtime = runtimeInfo()
        const stale = runtime.staleRuntime
            ? ` ${staleRuntimeMessage(runtime)}${runtime.staleRuntimeAllowed ? ' Development override is active.' : ''}`
            : ''
        return `Weavatrix ${runtime.version}; diskVersion=${runtime.diskVersion || 'unavailable'}; profile=${runtime.profile}; tools=${runtime.toolCount}; capabilities=${runtime.capabilities.join(',') || '(none)'}.${stale} If this differs from the client-visible tool list, reconnect the MCP client to discard its cached schema.`
    }
    let graph = null
    let graphError = null
    // ctx owns the CURRENT target: rebuild_graph reloads it, open_repo retargets graphPath/repoRoot
    // at runtime. loadInto always reads ctx.graphPath so both paths share one loader.
    const ctx = {graphPath: GRAPH_PATH, repoRoot: REPO_ROOT, reload: null, runtime: runtimeInfo(), extensions: api.extensions}
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
    const shutdown = createShutdownController({log, targetMutation: () => targetMutation})
    const autoRefresh = createAutoRefresh(() => api)
    const send = (msg) => {
        // A request that was already running when the client disconnected may complete during the
        // bounded drain. Do not write a late reply into a closed protocol pipe.
        if (shutdown.isShuttingDown() || process.stdout.destroyed || !process.stdout.writable) return false
        try {
            return process.stdout.write(JSON.stringify(msg) + '\n')
        } catch (error) {
            if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') return false
            throw error
        }
    }
    const reply = (id, result) => send({jsonrpc: '2.0', id, result})
    const fail = (id, code, message, data) => send({jsonrpc: '2.0', id, error: {code, message, ...(data ? {data} : {})}})

    const requestShutdown = shutdown.request
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
            const nextExtensions = await loadExtensions({version: v})
            const nextApi = await nextCatalog.loadHotApi(v, CAPS_ARG, {extensions: nextExtensions})
            catalog = nextCatalog
            api = nextApi
            extensions = nextExtensions
            ctx.runtime = runtimeInfo()
            ctx.extensions = api.extensions
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
        if (shutdown.isShuttingDown()) {
            if (!isNotification) fail(id, -32000, 'MCP server is shutting down')
            return
        }
        if (method === 'initialize' || method === 'tools/list' || method === 'tools/call') {
            const runtime = runtimeInfo()
            ctx.runtime = runtime
            if (runtime.staleRuntime && !runtime.staleRuntimeAllowed) {
                if (!isNotification) fail(id, -32001, staleRuntimeMessage(runtime), {'weavatrix/runtime': runtime})
                return
            }
        }
        if (method === 'initialize') {
            if (params?.protocolVersion) protocolVersion = String(params.protocolVersion)
            return reply(id, {
                protocolVersion, capabilities: {tools: {listChanged: true}}, serverInfo,
                instructions: runtimeInstructions(), _meta: {'weavatrix/runtime': runtimeInfo()},
            })
        }
        if (method === 'notifications/initialized' || method === 'initialized') return
        if (method === 'ping') return reply(id, {})
        if (method === 'tools/list') {
            await maybeHotReload()
            if (shutdown.isShuttingDown()) return
            return reply(id, {
                tools: api.tools.map(({name, description, inputSchema, outputSchema}) => ({name, description, inputSchema, outputSchema})),
                _meta: {'weavatrix/runtime': runtimeInfo()},
            })
        }
        if (method === 'tools/call') {
            await maybeHotReload()
            // EOF can arrive while the hot-reload import is pending. Do not enqueue a graph mutation
            // after requestShutdown captured the mutation chain it is responsible for draining.
            if (shutdown.isShuttingDown()) return
            const tool = api.byName.get(params?.name)
            if (!tool) return reply(id, {content: [{type: 'text', text: `Unknown tool: ${params?.name}`}], isError: true})
            const refreshesGraph = tool.cap === 'graph' || tool.cap === 'health' || tool.refreshGraph === true
            // Graph/health reads can establish a missing graph automatically when a repo root is known.
            if (!graph && !refreshesGraph && tool.cap !== 'build' && tool.cap !== 'retarget') return reply(id, {content: [{type: 'text', text: `Graph unavailable: ${graphError}`}], isError: true})
            const mutatesTarget = tool.cap === 'build' || tool.cap === 'retarget'
            const graphSnapshot = graph
            const callCtx = mutatesTarget ? ctx : {...ctx}
            const execute = async () => {
                const startedAt = performance.now()
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
                    const structuredBytes = normalized.structured ? Buffer.byteLength(JSON.stringify(normalized.structured)) : 0
                    const textBytes = Buffer.byteLength(text)
                    const durationMs = Math.max(0, performance.now() - startedAt)
                    const response = {
                        content: [{type: 'text', text}],
                        _meta: {
                            'weavatrix/metrics': {
                                schemaVersion: 'weavatrix.metrics.v1',
                                durationMs: Math.round(durationMs * 10) / 10,
                                textBytes,
                                structuredBytes,
                                estimatedOutputTokens: Math.ceil((textBytes + structuredBytes) / 4),
                                graphFreshness: staleLine ? 'stale' : (refresh?.error ? 'stale' : 'fresh'),
                                graphUpdate: refresh?.kind || 'none',
                                graphRevision: refresh?.revision || callGraph?.graphRevision || null,
                                cache: refreshesGraph ? (refresh?.kind === 'none' ? 'graph-hit' : 'graph-refreshed') : 'not-applicable',
                            },
                        },
                    }
                    if (normalized.structured) response.structuredContent = normalized.structured
                    return reply(id, response)
                } catch (e) {
                    log(`tool ${params?.name} threw: ${e.stack || e.message}`)
                    const text = `Tool error: ${e.message}`
                    return reply(id, {
                        content: [{type: 'text', text}], isError: true,
                        _meta: {'weavatrix/metrics': {
                            schemaVersion: 'weavatrix.metrics.v1', durationMs: Math.round(Math.max(0, performance.now() - startedAt) * 10) / 10,
                            textBytes: Buffer.byteLength(text), structuredBytes: 0,
                            estimatedOutputTokens: Math.ceil(Buffer.byteLength(text) / 4), graphFreshness: 'unknown',
                            graphUpdate: 'none', graphRevision: graphSnapshot?.graphRevision || null, cache: 'not-applicable',
                        }},
                    })
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
        if (shutdown.isShuttingDown()) return
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
const directEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (directEntry && !globalThis.__weavatrixMcpStarted) {
    globalThis.__weavatrixMcpStarted = true
    startMcpServer()
}
