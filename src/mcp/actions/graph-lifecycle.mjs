import {existsSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'
import {diffGraphs, formatGraphDiff, prevGraphPathFor} from '../graph-context.mjs'
import {buildGraphForRepo, defaultPrecisionMode, precisionStatusLine} from '../../build-graph.js'
import {graphHomeDir, graphOutDirForModule, graphOutDirForRepo} from '../../graph/layout.js'
import {liveRepositoryRecords, registerRepository} from '../../graph/repo-registry.js'
import {precisionSemanticInputsMatch, readPrecisionOverlay} from '../../precision/lsp-overlay.js'

export async function tRebuildGraph(g, args, ctx) {
    if (!ctx.repoRoot) return 'Rebuild needs the repo root (not provided to this server).'
    const mode = ['no-tests', 'tests-only', 'full'].includes(args.mode)
        ? args.mode
        : ['no-tests', 'tests-only', 'full'].includes(g?.graphBuildMode) ? g.graphBuildMode : 'full'
    const precision = args.precision === 'off' ? 'off' : args.precision === 'lsp' ? 'lsp' : (g?.graphPrecisionMode || defaultPrecisionMode())
    const scope = String(args.scope || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (scope) {
        const scopedDir = graphOutDirForModule(ctx.repoRoot, scope)
        const scoped = await buildGraphForRepo(ctx.repoRoot, {mode, scope, precision, outDir: scopedDir})
        if (!scoped || !scoped.ok) return `Scoped graph build failed: ${(scoped && scoped.error) || 'unknown error'}`
        return [
            `Built an isolated scoped graph for ${scope} (${mode}). ${scoped.log || ''}.`,
            `The active full-repository graph was not replaced, so this operation cannot report a false full→scope structural delta.`,
            `Scoped graph: ${join(scopedDir, 'graph.json')}`,
        ].join('\n')
    }
    // snapshot the outgoing state: bytes → graph.prev.json (for graph_diff later), struct → inline delta
    let prevBytes = null
    try { prevBytes = readFileSync(ctx.graphPath) } catch { /* first build — nothing to diff against */ }
    let before = null
    try { before = prevBytes ? JSON.parse(prevBytes.toString('utf8')) : null } catch { before = null }
    const res = await buildGraphForRepo(ctx.repoRoot, {mode, scope: '', precision, outDir: ctx.graphPath ? dirname(ctx.graphPath) : undefined})
    if (!res || !res.ok) return `Graph rebuild failed: ${(res && res.error) || 'unknown error'}`
    if (prevBytes) { try { writeFileSync(prevGraphPathFor(ctx.graphPath), prevBytes) } catch { /* snapshot is best-effort */ } }
    const fresh = ctx.reload() // refresh THIS server's in-memory graph so subsequent tool calls see the new graph
    let afterStatic = null
    try { afterStatic = JSON.parse(readFileSync(ctx.graphPath, 'utf8')) } catch { /* reload already reports the failure */ }
    const beforeMode = ['full', 'no-tests', 'tests-only'].includes(before?.graphBuildMode) ? before.graphBuildMode : 'full'
    const afterMode = ['full', 'no-tests', 'tests-only'].includes(afterStatic?.graphBuildMode) ? afterStatic.graphBuildMode : 'full'
    const delta = before && afterStatic
        ? beforeMode === afterMode
            ? formatGraphDiff(diffGraphs(before, afterStatic))
            : `Structural delta not computed: build mode changed from ${beforeMode} to ${afterMode}, so the node/edge universes are not comparable.`
        : null
    return [
        `Rebuilt the graph (${mode}). ${res.log || ''}. In-memory graph reloaded — graph tools now reflect it.`,
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
    const graphExists = existsSync(graphPath)
    const requestedMode = ['no-tests', 'tests-only', 'full'].includes(args.mode) ? args.mode : null
    const requestedPrecision = ['lsp', 'off'].includes(args.precision) ? args.precision : null
    let built = false
    let upgrade = false
    let schemaUpgrade = false
    let precisionUpgrade = false
    let savedMode = 'full'
    let savedPrecision = defaultPrecisionMode()
    if (graphExists) {
        try {
            const saved = JSON.parse(readFileSync(graphPath, 'utf8'))
            savedMode = ['no-tests', 'tests-only', 'full'].includes(saved.graphBuildMode) ? saved.graphBuildMode : 'full'
            savedPrecision = ['lsp', 'off'].includes(saved.graphPrecisionMode) ? saved.graphPrecisionMode : defaultPrecisionMode()
            schemaUpgrade = !Number.isInteger(saved.edgeTypesV) || saved.edgeTypesV < 2
                || !Number.isInteger(saved.edgeProvenanceV) || saved.edgeProvenanceV < 1
                || !Number.isInteger(saved.extractorSchemaV) || saved.extractorSchemaV < 7
                || !Number.isInteger(saved.reExportOccurrencesV) || saved.reExportOccurrencesV < 1
                || !Number.isInteger(saved.symbolSpacesV) || saved.symbolSpacesV < 1
                || !Number.isInteger(saved.physicalFileLocV) || saved.physicalFileLocV < 1
            if (savedPrecision === 'lsp') {
                const overlay = readPrecisionOverlay(graphPath, saved)
                precisionUpgrade = !overlay || (typeof overlay.semanticInputFingerprint === 'string'
                    && !precisionSemanticInputsMatch(overlay, repoPath, saved))
            }
            upgrade = schemaUpgrade || precisionUpgrade
        } catch {
            upgrade = true
        }
    }
    const modeMismatch = graphExists && requestedMode != null && requestedMode !== savedMode
    const precisionMismatch = graphExists && requestedPrecision != null && requestedPrecision !== savedPrecision
    if (!graphExists || upgrade || modeMismatch || precisionMismatch) {
        if (args.build === false) {
            if (modeMismatch && !upgrade) {
                return `The existing graph for ${repoPath} was built in ${savedMode}, but ${requestedMode} was requested. Re-call without build:false to rebuild it before switching.`
            }
            if (precisionMismatch && !upgrade) {
                return `The existing graph for ${repoPath} uses semantic precision ${savedPrecision}, but ${requestedPrecision} was requested. Re-call without build:false to rebuild it before switching.`
            }
            return upgrade
                ? precisionUpgrade && !schemaUpgrade
                    ? `The existing graph for ${repoPath} lacks current revision-matched semantic precision evidence. Re-call without build:false to refresh it before switching.`
                    : `The existing graph for ${repoPath} predates current graph metadata (typed edges, provenance, or physical file LOC). Re-call without build:false to upgrade it before switching.`
                : `No graph yet for ${repoPath} (expected at ${graphPath}). Re-call without build:false to build one — large repos can take minutes.`
        }
        const mode = requestedMode || (graphExists ? savedMode : 'full')
        const precision = requestedPrecision || (graphExists ? savedPrecision : defaultPrecisionMode())
        const res = await buildGraphForRepo(repoPath, {mode, scope: '', precision})
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
    registerRepository({repoPath, graphDir: graphOutDirForRepo(repoPath), graphHome: graphHomeDir()})
    const buildNote = built ? (upgrade ? ' (graph upgraded to current edge/precision metadata)' : modeMismatch ? ' (graph rebuilt in the requested mode)' : precisionMismatch ? ' (semantic precision mode updated)' : ' (graph built fresh)') : ''
    return [
        `Opened ${repoPath}${buildNote}: ${loaded.nodes.length} nodes / ${loaded.links.length} edges. All tools now target this repo.`,
        `Graph: ${graphPath}`,
        `Build mode: ${loaded.graphBuildMode || 'full'}`,
        precisionStatusLine(loaded.precision),
    ].join('\n')
}

// Sibling repos that already have a built graph in the central weavatrix-graphs folder — open_repo candidates.
export function tListKnownRepos(g, args, ctx) {
    const root = graphHomeDir()
    const norm = (p) => String(p).replace(/[\\/]+/g, '/').toLowerCase()
    const rows = liveRepositoryRecords(root).map((record) => ({
        ...record,
        builtAt: statSync(join(record.graphDir, 'graph.json')).mtime.toISOString(),
    }))
    if (!rows.length) return `No registered graphs under ${root}. Build a repository once with open_repo or rebuild_graph.`
    return [
        `Known repositories (${rows.length}) in ${root}:`,
        ...rows.map((r) => `  ${norm(r.repoPath) === norm(ctx.repoRoot) ? '»' : ' '} ${r.label} [${r.repositoryId}] — graph built ${r.builtAt}  (${r.repoPath})`),
    ].join('\n')
}
