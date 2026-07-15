// weavatrix MCP server — the stdio entry point. The tool implementations live in src/mcp/*:
//   graph-context.mjs  — graph load + indexes, node resolution, staleness, raw-graph cache, diffs
//   tools-graph.mjs    — graph query tools        tools-impact.mjs  — dependents / diff / change impact
//   tools-health.mjs   — audit / clones / coverage / endpoints
//   tools-actions.mjs  — rebuild / open_repo / list_known_repos + the 'online' group
//   catalog.mjs        — tool catalog, capability filter, hot-reload loader
// Spawned by Claude Code / Codex as a plain Node child (node mcp-server.mjs <graph.json> <repoRoot>).
// Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
//
// .mjs on purpose: guarantees ESM parsing regardless of the nearest package.json. The server itself
// resolves nothing from node_modules at runtime (ripgrep is probed, with a pure-Node fallback); only
// the graph BUILDER pulls in web-tree-sitter + its WASM grammars when a build is requested.
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

// version comes from package.json so serverInfo can never drift from the published package again
const PKG_VERSION = (() => { try { return createRequire(import.meta.url)('../package.json').version } catch { return '0.0.0' } })()
const SERVER_INFO = {name: 'weavatrix', version: PKG_VERSION}
const DEFAULT_PROTOCOL = '2024-11-05'
const log = (...a) => process.stderr.write(`[weavatrix] ${a.join(' ')}\n`)

// argv[2] is a repo DIRECTORY in the npx form — derive the graph location from the standard layout;
// otherwise it is the graph.json path and the repo root follows it.
let GRAPH_PATH = process.argv[2]
let repoArg = process.argv[3]
// caps ABSENT (undefined) = offline defaults (including explicit-call repo retargeting, no network).
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
    const loadInto = () => { graph = loadGraph(ctx.graphPath); graphError = null; return graph }
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
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
    const reply = (id, result) => send({jsonrpc: '2.0', id, result})
    const fail = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}})

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
        if (method === 'initialize') {
            if (params?.protocolVersion) protocolVersion = String(params.protocolVersion)
            return reply(id, {protocolVersion, capabilities: {tools: {listChanged: true}}, serverInfo: SERVER_INFO})
        }
        if (method === 'notifications/initialized' || method === 'initialized') return
        if (method === 'ping') return reply(id, {})
        if (method === 'tools/list') {
            await maybeHotReload()
            return reply(id, {tools: api.tools.map(({name, description, inputSchema}) => ({name, description, inputSchema}))})
        }
        if (method === 'tools/call') {
            await maybeHotReload()
            const tool = api.byName.get(params?.name)
            if (!tool) return reply(id, {content: [{type: 'text', text: `Unknown tool: ${params?.name}`}], isError: true})
            // action tools can establish/retarget a graph; read tools need one already loaded
            if (!graph && tool.cap !== 'build' && tool.cap !== 'retarget') return reply(id, {content: [{type: 'text', text: `Graph unavailable: ${graphError}`}], isError: true})
            try {
                let text = String(await tool.run(graph, params?.arguments || {}, ctx))
                if (graph && graph.edgeTypesV < 2 && (tool.cap === 'graph' || tool.cap === 'health')) {
                    text += '\n\nWarning: this saved graph predates compile-only edge metadata (edge schema v2), so Rust module/use dependencies may be absent or misclassified. Call rebuild_graph once before acting on cycle, boundary, dependency, or blast-radius findings.'
                }
                // Graph answers silently reflect a point-in-time build — surface staleness on every graph tool.
                if (tool.cap === 'graph') {
                    const warn = api.stalenessLine(ctx)
                    if (warn) text += `\n\n${warn}`
                }
                return reply(id, {content: [{type: 'text', text}]})
            } catch (e) {
                log(`tool ${params?.name} threw: ${e.stack || e.message}`)
                return reply(id, {content: [{type: 'text', text: `Tool error: ${e.message}`}], isError: true})
            }
        }
        if (!isNotification) return fail(id, -32601, `Method not found: ${method}`)
    }

    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
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
    process.stdin.on('end', () => process.exit(0))
    log('ready')
}

// Guard: hot-reload re-imports of tool modules never touch this entry, but keep the start guard so a
// stray re-import of the entry itself can never spawn a second stdio loop.
if (!globalThis.__weavatrixMcpStarted) {
    globalThis.__weavatrixMcpStarted = true
    main()
}
