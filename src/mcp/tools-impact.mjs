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

// Transitive blast-radius: who is affected if this node changes. Walks REVERSE dependency edges
// (calls/imports/inherits — not structural `contains`) out to `depth`. For a symbol, also seeds its
// containing file, because importers depend on the file rather than the individual symbol.
export function tGetDependents(g, {label, depth = 3, max_nodes = 40} = {}) {
    const info = resolveNodeInfo(g, label)
    const n = info.node
    if (!n) return `No node found matching "${label}".`
    const note = ambiguityNote(label, info)
    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3))
    const cap = Math.max(5, Math.min(120, Number(max_nodes) || 40))
    const id = String(n.id)
    const seeds = new Set([id])
    let containingFile = null
    if (isSymbol(id)) {
        const container = (g.inn.get(id) || []).find((e) => e.relation === 'contains')
        if (container) {
            containingFile = String(container.id)
            seeds.add(containingFile)
        }
    }
    const depthOf = new Map([...seeds].map((s) => [s, 0]))
    const relOf = new Map()
    let frontier = [...seeds]
    for (let d = 0; d < maxDepth && frontier.length; d++) {
        const next = []
        for (const cur of frontier) {
            for (const e of g.inn.get(cur) || []) {
                if (e.relation === 'contains') continue // structural nesting is not a dependency
                const nid = String(e.id)
                if (depthOf.has(nid)) continue
                depthOf.set(nid, d + 1)
                relOf.set(nid, e.relation || 'rel')
                next.push(nid)
            }
        }
        frontier = next
    }
    const ranked = [...depthOf.entries()]
        .filter(([nid]) => !seeds.has(nid))
        .map(([nid, d]) => ({id: nid, d, deg: degreeOf(g, nid)}))
        .sort((a, b) => a.d - b.d || b.deg - a.deg)
    if (!ranked.length) return [note, `No dependents found for ${n.label ?? id} within depth ${maxDepth} — nothing in the graph calls, imports, or inherits it.`].filter(Boolean).join('\n')
    const shown = ranked.slice(0, cap)
    return [
        note,
        `Dependents of ${n.label ?? id} (reverse calls/imports/inherits, depth ≤${maxDepth}): ${ranked.length} found, showing ${shown.length} by proximity + connectivity.`,
        containingFile ? `Includes importers of its containing file ${labelOf(g, containingFile)}.` : null,
        ...shown.map((r) => `  [d${r.d}] ${relOf.get(r.id) || 'rel'}  ${labelOf(g, r.id)}  (deg ${r.deg})  [${r.id}]`),
    ].filter(Boolean).join('\n')
}

// Re-query the last rebuild's before/after pair (graph.prev.json vs graph.json), optionally scoped.
export function tGraphDiff(g, args, ctx) {
    const prevPath = prevGraphPathFor(ctx.graphPath)
    let prev
    try { prev = JSON.parse(readFileSync(prevPath, 'utf8')) } catch {
        return `No previous graph state at ${prevPath} — rebuild_graph saves one automatically (a single prior state is kept).`
    }
    const current = rawGraph(ctx)
    const filter = args.path ? String(args.path).replace(/\\/g, '/') : null
    const scope = (graph) => filter ? {
        nodes: (graph.nodes || []).filter((n) => String(n.id).startsWith(filter)),
        links: (graph.links || []).filter((l) => String(edgeEndpoint(l.source)).startsWith(filter) || String(edgeEndpoint(l.target)).startsWith(filter))
    } : graph
    return [
        `Graph diff (previous rebuild state → current)${filter ? `, scoped to ${filter}` : ''}:`,
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
    const depthOf = new Map([...seeds].map((s) => [s, 0]))
    const relOf = new Map()
    let frontier = [...seeds]
    for (let d = 0; d < maxDepth && frontier.length; d++) {
        const next = []
        for (const cur of frontier) {
            for (const e of g.inn.get(cur) || []) {
                if (e.relation === 'contains') continue
                const nid = String(e.id)
                if (depthOf.has(nid)) continue
                depthOf.set(nid, d + 1)
                relOf.set(nid, e.relation || 'rel')
                next.push(nid)
            }
        }
        frontier = next
    }
    const fileOfNode = (id) => { const s = String(id); const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h) }
    const impacted = [...depthOf.entries()]
        .filter(([nid]) => !seeds.has(nid) && !changedSet.has(fileOfNode(nid)))
        .map(([nid, d]) => ({id: nid, d, deg: degreeOf(g, nid), file: fileOfNode(nid)}))
        .sort((a, b) => a.d - b.d || b.deg - a.deg)

    // coverage overlay from EXISTING reports (fractions 0..1) — see coverage_map for details
    const knownFiles = (rawGraph(ctx).nodes || []).filter((n) => !String(n.id).includes('#') && n.source_file).map((n) => n.source_file)
    const coverage = readCoverageForRepo(ctx.repoRoot, knownFiles)
    const covOf = (file) => coverage.get(String(file).replace(/\\/g, '/'))?.pct ?? null
    const pctStr = (v) => (v == null ? 'cov n/a' : `cov ${Math.round(v * 100)}%`)

    const shown = impacted.slice(0, cap)
    const untestedHotspots = shown.filter((n) => { const c = covOf(n.file); return c != null && c < 0.5 && n.deg >= 5 })
    return [
        `Change impact ${sourceLabel}: ${changed.length} changed file(s) → ${seeds.size} graph seed(s) incl. their symbols${unmapped.length ? `; ${unmapped.length} file(s) not in the graph (new/non-code — rebuild_graph refreshes)` : ''}.`,
        impacted.length
            ? `${impacted.length} impacted node(s) within ${maxDepth} reverse hop(s), showing ${shown.length}:`
            : `Nothing else in the graph depends on the changed code within ${maxDepth} hop(s).`,
        ...shown.map((n) => `  [d${n.d}] ${relOf.get(n.id) || 'rel'}  ${labelOf(g, n.id)}  (deg ${n.deg}, ${pctStr(covOf(n.file))})  [${n.id}]`),
        untestedHotspots.length ? `` : null,
        untestedHotspots.length ? `Untested hotspots in the blast radius (<50% coverage, deg ≥5) — cover these before shipping:` : null,
        ...untestedHotspots.slice(0, 10).map((n) => `  ${labelOf(g, n.id)}  (${pctStr(covOf(n.file))}, deg ${n.deg})  ${n.file}`),
        ``,
        `Drill into any node with get_dependents / read_source; per-symbol coverage via coverage_map.`,
    ].filter((x) => x != null).join('\n')
}
