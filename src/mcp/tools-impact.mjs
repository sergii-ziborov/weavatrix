// Impact tools: transitive blast radius of one node (get_dependents), the structural diff of the
// last rebuild (graph_diff), and the blast radius of the current change set (change_impact).
// Hot-reloadable (re-imported by catalog.mjs on change).
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../child-env.js'
import {
    isSymbol, degreeOf, labelOf, resolveNodeInfo, ambiguityNote,
    rawGraph, prevGraphPathFor, edgeEndpoint, diffGraphs, formatGraphDiff,
} from './graph-context.mjs'
import {readCoverageForRepo} from '../analysis/coverage-reports.js'
import {isStructuralRelation} from '../graph/relations.js'
import {tChangeImpactV2} from './tools-impact-change.mjs'
import {buildGraphAtGitRef} from '../analysis/git-ref-graph.js'

function reverseReach(g, seeds, maxDepth) {
    const states = new Map([...seeds].map((id) => [String(id), {
        runtimeDepth: 0, runtimeRelation: null, compileDepth: null, compileRelation: null,
    }]))
    const frontier = [...seeds].map((id) => ({id: String(id), depth: 0, compileOnly: false}))
    for (let cursor = 0; cursor < frontier.length; cursor++) {
        const current = frontier[cursor]
        if (current.depth >= maxDepth) continue
        for (const e of g.inn.get(current.id) || []) {
            if (isStructuralRelation(e.relation) || e.barrelProxy === true) continue
            const id = String(e.id)
            const compileOnly = current.compileOnly || e.typeOnly === true || e.compileOnly === true
            const depth = current.depth + 1
            const entry = states.get(id) || {
                runtimeDepth: null, runtimeRelation: null, compileDepth: null, compileRelation: null,
            }
            const depthKey = compileOnly ? 'compileDepth' : 'runtimeDepth'
            const relationKey = compileOnly ? 'compileRelation' : 'runtimeRelation'
            const provenanceKey = compileOnly ? 'compileProvenance' : 'runtimeProvenance'
            if (entry[depthKey] != null && entry[depthKey] <= depth) continue
            entry[depthKey] = depth
            entry[relationKey] = e.relation || 'rel'
            entry[provenanceKey] = e.provenance || 'UNKNOWN'
            states.set(id, entry)
            frontier.push({id, depth, compileOnly})
        }
    }
    return new Map([...states].map(([id, entry]) => [id, {
        ...entry,
        depth: entry.runtimeDepth ?? entry.compileDepth ?? 0,
        compileOnly: entry.runtimeDepth == null,
        relation: entry.runtimeDepth != null ? entry.runtimeRelation : entry.compileRelation,
        provenance: entry.runtimeDepth != null ? entry.runtimeProvenance : entry.compileProvenance,
    }]))
}

const impactKind = (entry) => {
    if (entry?.runtimeDepth != null) {
        return entry.compileDepth != null ? `runtime + compile-time(d${entry.compileDepth})` : 'runtime'
    }
    return 'compile-time'
}

// Transitive blast-radius: who is affected if this node changes. Walks REVERSE dependency edges
// (calls/imports/inherits — not structural `contains`) out to `depth`. For a symbol, also seeds its
// containing file, because importers depend on the file rather than the individual symbol.
export function tGetDependents(g, {label, depth = 3, max_nodes = 40, include_container_importers = false} = {}) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3))
    const cap = Math.max(5, Math.min(120, Number(max_nodes) || 40))
    const id = String(n.id)
    const seeds = new Set([id])
    let containingFile = null
    if (include_container_importers === true && isSymbol(id)) {
        const container = (g.inn.get(id) || []).find((e) => e.relation === 'contains')
        if (container) {
            containingFile = String(container.id)
            seeds.add(containingFile)
        }
    }
    const reached = reverseReach(g, seeds, maxDepth)
    const ranked = [...reached.entries()]
        .filter(([nid]) => !seeds.has(nid))
        .map(([nid, entry]) => ({id: nid, d: entry.depth, entry, deg: degreeOf(g, nid)}))
        .sort((a, b) => a.d - b.d || Number(a.entry.compileOnly) - Number(b.entry.compileOnly) || b.deg - a.deg)
    if (!ranked.length) return [note, `No dependents found for ${n.label ?? id} within depth ${maxDepth} — nothing in the graph calls, imports, or inherits it.`].filter(Boolean).join('\n')
    const shown = ranked.slice(0, cap)
    const runtimeCount = ranked.filter((entry) => !entry.entry.compileOnly).length
    const compileCount = ranked.length - runtimeCount
    return [
        note,
        `Dependents of ${n.label ?? id} (reverse calls/imports/inherits, depth ≤${maxDepth}): ${ranked.length} found (${runtimeCount} runtime, ${compileCount} compile-time-only), showing ${shown.length} by proximity + connectivity.`,
        containingFile ? `Includes importers of its containing file ${labelOf(g, containingFile)} by explicit request.` : null,
        ...shown.map((r) => `  [d${r.d} ${impactKind(r.entry)}] ${r.entry.relation || 'rel'} [${r.entry.provenance || 'UNKNOWN'}]  ${labelOf(g, r.id)}  (deg ${r.deg})  [${r.id}]`),
    ].filter(Boolean).join('\n')
}

// Re-query the last rebuild's before/after pair (graph.prev.json vs graph.json), optionally scoped.
export async function tGraphDiff(g, args, ctx) {
    const current = rawGraph(ctx)
    const currentMode = ['full', 'no-tests', 'tests-only'].includes(current?.graphBuildMode)
        ? current.graphBuildMode
        : 'full'
    let prev
    let baselineLabel = 'previous rebuild state'
    if (args.base_ref) {
        if (!ctx.repoRoot) return 'A Git-ref graph diff needs the active repository root.'
        const built = await buildGraphAtGitRef(ctx.repoRoot, args.base_ref, {mode: currentMode})
        if (!built.ok) return `Could not build the baseline graph: ${built.error}`
        prev = built.graph
        baselineLabel = `${built.ref} (${built.commit.slice(0, 12)})`
    } else {
        const prevPath = prevGraphPathFor(ctx.graphPath)
        try { prev = JSON.parse(readFileSync(prevPath, 'utf8')) } catch {
            return `No previous graph state at ${prevPath} — pass base_ref (for example HEAD~1 or main), or run rebuild_graph to save one automatically.`
        }
    }
    if (!args.base_ref) {
        const previousMode = ['full', 'no-tests', 'tests-only'].includes(prev?.graphBuildMode)
            ? prev.graphBuildMode
            : 'full'
        if (previousMode !== currentMode) {
            return [
                `Graph diff unavailable: previous graph mode is ${previousMode}, current graph mode is ${currentMode}.`,
                'Those node/edge universes are not comparable. Run rebuild_graph once more in the same mode, or pass base_ref to build a mode-matched immutable baseline.',
            ].join('\n')
        }
    }
    const filter = args.path ? String(args.path).replace(/\\/g, '/') : null
    const scope = (graph) => filter ? {
        nodes: (graph.nodes || []).filter((n) => String(n.id).startsWith(filter)),
        links: (graph.links || []).filter((l) => String(edgeEndpoint(l.source)).startsWith(filter) || String(edgeEndpoint(l.target)).startsWith(filter)),
        edgeTypesV: graph.edgeTypesV || 0,
        edgeProvenanceV: graph.edgeProvenanceV || 0,
        barrelResolutionV: graph.barrelResolutionV || 0,
        extractorSchemaV: graph.extractorSchemaV || 0,
    } : graph
    return [
        `Graph diff (${baselineLabel} → current)${filter ? `, scoped to ${filter}` : ''}:`,
        `Build mode: ${currentMode}`,
        formatGraphDiff(diffGraphs(scope(prev), scope(current)))
    ].join('\n')
}

// ---- change impact -------------------------------------------------------------------------------
function gitLines(repoRoot, args) {
    const res = spawnSync('git', ['-C', repoRoot, ...args], {encoding: 'utf8', timeout: 8000, env: childProcessEnv()})
    if (res.status !== 0) return null
    return String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function resolveImpactBase(repoRoot, requested) {
    const candidates = requested ? [requested] : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']
    for (const ref of candidates) {
        const ok = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {encoding: 'utf8', timeout: 8000, env: childProcessEnv()})
        if (ok.status === 0) return ref
    }
    return null
}

// Blast radius of a change, without any GitHub API: diff the CURRENT change (branch
// commits since the merge-base + staged/unstaged + untracked) against a base ref, map the changed
// files and their symbols onto the graph, and walk REVERSE dependency edges — everything the change
// can break, ranked by proximity + connectivity, with file-level test coverage attached so the
// untested part of the blast radius stands out. The pre-PR review, in one call.
export function tChangeImpact(g, args, ctx) {
    return tChangeImpactV2(g, args, ctx)
}

// Kept private during the v2 rollout so the surrounding get_dependents/graph_diff implementation is
// untouched; focused tests exercise the exported symbol-aware path above.
function tChangeImpactLegacy(g, args, ctx) {
    if (!ctx.repoRoot) return 'change_impact needs the repo root (not provided to this server).'
    // Explicit file list (e.g. a PR's changed files) skips the local git diff entirely — this is how
    // a NOT-checked-out PR gets its impact assessed.
    const explicit = Array.isArray(args.files)
        ? [...new Set(args.files.map((f) => String(f).replace(/\\/g, '/').trim()).filter(Boolean))]
        : null
    let changed
    let sourceLabel
    if (explicit) {
        if (!explicit.length) return 'files was provided but empty — pass repo-relative paths, or omit it to diff the local change.'
        changed = explicit
        sourceLabel = `for ${changed.length} provided file(s)`
    } else {
        const base = resolveImpactBase(ctx.repoRoot, args.base ? String(args.base).trim() : '')
        if (!base) return `Could not resolve a base ref${args.base ? ` ("${args.base}")` : ''} — pass base explicitly (e.g. origin/main or HEAD~1).`
        const committed = gitLines(ctx.repoRoot, ['diff', '--name-only', `${base}...HEAD`])
        if (committed === null) return `git diff against ${base} failed — is ${ctx.repoRoot} a git repository?`
        const uncommitted = gitLines(ctx.repoRoot, ['diff', '--name-only', 'HEAD']) || []
        const untracked = gitLines(ctx.repoRoot, ['ls-files', '--others', '--exclude-standard']) || []
        changed = [...new Set([...committed, ...uncommitted, ...untracked])]
        sourceLabel = `vs ${base}`
        if (!changed.length) return `No changes vs ${base} — working tree clean and no branch commits.`
    }

    const changedSet = new Set(changed)
    const seeds = new Set()
    const unmapped = []
    for (const file of changed) {
        if (!g.byId.has(file)) { unmapped.push(file); continue }
        seeds.add(file)
        for (const e of g.out.get(file) || []) if (e.relation === 'contains') seeds.add(String(e.id))
    }
    if (!seeds.size) {
        return [
            `${changed.length} changed file(s) ${sourceLabel}, but none are in the graph — new files or non-code.`,
            `Run rebuild_graph and retry for the full picture.`,
            `Changed: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}`,
        ].join('\n')
    }

    const maxDepth = Math.max(1, Math.min(4, Number(args.depth) || 2))
    const cap = Math.max(5, Math.min(120, Number(args.max_nodes) || 40))
    const reached = reverseReach(g, seeds, maxDepth)
    const fileOfNode = (id) => { const s = String(id); const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h) }
    const impacted = [...reached.entries()]
        .filter(([nid]) => !seeds.has(nid) && !changedSet.has(fileOfNode(nid)))
        .map(([nid, entry]) => ({id: nid, d: entry.depth, entry, deg: degreeOf(g, nid), file: fileOfNode(nid)}))
        .sort((a, b) => a.d - b.d || Number(a.entry.compileOnly) - Number(b.entry.compileOnly) || b.deg - a.deg)

    // coverage overlay from EXISTING reports (fractions 0..1) — see coverage_map for details
    const knownFiles = (rawGraph(ctx).nodes || []).filter((n) => !String(n.id).includes('#') && n.source_file).map((n) => n.source_file)
    const coverage = readCoverageForRepo(ctx.repoRoot, knownFiles)
    const covOf = (file) => coverage.get(String(file).replace(/\\/g, '/'))?.pct ?? null
    const pctStr = (v) => (v == null ? 'cov n/a' : `cov ${Math.round(v * 100)}%`)
    const hasCoverage = coverage.size > 0

    const shown = impacted.slice(0, cap)
    const runtimeImpacted = impacted.filter((entry) => !entry.entry.compileOnly).length
    const compileImpacted = impacted.length - runtimeImpacted
    const untestedHotspots = shown.filter((n) => { const c = covOf(n.file); return c != null && c < 0.5 && n.deg >= 5 })
    return [
        `Change impact ${sourceLabel}: ${changed.length} changed file(s) → ${seeds.size} graph seed(s) incl. their symbols${unmapped.length ? `; ${unmapped.length} file(s) not in the graph (new/non-code — rebuild_graph refreshes)` : ''}.`,
        impacted.length
            ? `${impacted.length} impacted node(s) within ${maxDepth} reverse hop(s) (${runtimeImpacted} runtime, ${compileImpacted} compile-time-only), showing ${shown.length}:`
            : `Nothing else in the graph depends on the changed code within ${maxDepth} hop(s).`,
        hasCoverage ? `Coverage: existing report mapped where available.` : `Coverage: unavailable (no supported report found); per-node coverage labels omitted.`,
        ...shown.map((n) => `  [d${n.d} ${impactKind(n.entry)}] ${n.entry.relation || 'rel'}  ${labelOf(g, n.id)}  (deg ${n.deg}${hasCoverage ? `, ${pctStr(covOf(n.file))}` : ''})  [${n.id}]`),
        untestedHotspots.length ? `` : null,
        untestedHotspots.length ? `Untested hotspots in the blast radius (<50% coverage, deg ≥5) — cover these before shipping:` : null,
        ...untestedHotspots.slice(0, 10).map((n) => `  ${labelOf(g, n.id)}  (${pctStr(covOf(n.file))}, deg ${n.deg})  ${n.file}`),
        ``,
        `Drill into any node with get_dependents / read_source; per-symbol coverage via coverage_map.`,
    ].filter((x) => x != null).join('\n')
}
