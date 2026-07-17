// Symbol-aware change_impact implementation, isolated from the other hot impact tools so its
// classifier/evidence contract can be tested without perturbing get_dependents or graph_diff.
import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../child-env.js'
import {classifyChangeImpact} from '../analysis/change-classification.js'
import {readCoverageForRepo} from '../analysis/coverage-reports.js'
import {computeStaticTestReachability} from '../analysis/static-test-reachability.js'
import {isStructuralRelation} from '../graph/relations.js'
import {degreeOf, labelOf, rawGraph} from './graph-context.mjs'
import {toolResult} from './tool-result.mjs'

function gitLines(repoRoot, args) {
    const result = spawnSync('git', ['-C', repoRoot, ...args], {encoding: 'utf8', timeout: 8000, env: childProcessEnv()})
    if (result.status !== 0) return null
    return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function gitValue(repoRoot, args) {
    const result = spawnSync('git', ['-C', repoRoot, ...args], {encoding: 'utf8', timeout: 8000, env: childProcessEnv()})
    if (result.status !== 0) return null
    return String(result.stdout || '').trim() || null
}

function resolveImpactBase(repoRoot, requested) {
    const candidates = requested ? [requested] : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']
    for (const ref of candidates) {
        const value = gitValue(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
        if (value) return ref
    }
    return null
}

function reverseReach(g, seeds, maxDepth) {
    const states = new Map([...seeds].map((id) => [String(id), {
        runtimeDepth: 0, runtimeRelation: null, compileDepth: null, compileRelation: null,
    }]))
    const frontier = [...seeds].map((id) => ({id: String(id), depth: 0, compileOnly: false}))
    for (let cursor = 0; cursor < frontier.length; cursor++) {
        const current = frontier[cursor]
        if (current.depth >= maxDepth) continue
        for (const edge of g.inn.get(current.id) || []) {
            if (isStructuralRelation(edge.relation) || edge.barrelProxy === true) continue
            const id = String(edge.id)
            const compileOnly = current.compileOnly || edge.typeOnly === true || edge.compileOnly === true
            const depth = current.depth + 1
            const entry = states.get(id) || {runtimeDepth: null, runtimeRelation: null, compileDepth: null, compileRelation: null}
            const depthKey = compileOnly ? 'compileDepth' : 'runtimeDepth'
            const relationKey = compileOnly ? 'compileRelation' : 'runtimeRelation'
            if (entry[depthKey] != null && entry[depthKey] <= depth) continue
            entry[depthKey] = depth
            entry[relationKey] = edge.relation || 'rel'
            states.set(id, entry)
            frontier.push({id, depth, compileOnly})
        }
    }
    return new Map([...states].map(([id, entry]) => [id, {
        ...entry,
        depth: entry.runtimeDepth ?? entry.compileDepth ?? 0,
        compileOnly: entry.runtimeDepth == null,
        relation: entry.runtimeDepth != null ? entry.runtimeRelation : entry.compileRelation,
    }]))
}

const impactKind = (entry) => entry?.runtimeDepth != null
    ? (entry.compileDepth != null ? `runtime + compile-time(d${entry.compileDepth})` : 'runtime')
    : 'compile-time'

const fileOfNode = (id) => {
    const value = String(id)
    const hash = value.indexOf('#')
    return hash < 0 ? value : value.slice(0, hash)
}

const partialResult = (text, reason, status = 'UNAVAILABLE') => toolResult(text, {
    status,
    verdict: 'HIGH',
    reasons: [reason],
    changes: [],
    seeds: {ids: [], unmappedIds: []},
    blastRadius: {impacted: 0, runtime: 0, compileTimeOnly: 0, nodes: []},
}, {completeness: {status: 'PARTIAL', reason}})

export function tChangeImpactV2(g, args = {}, ctx = {}) {
    if (!ctx.repoRoot) return partialResult(
        'HIGH — change impact unavailable\nNo repository root is active; no diff can be classified safely.',
        'Repository root unavailable.'
    )

    const explicit = Array.isArray(args.files)
        ? [...new Set(args.files.map((file) => String(file).replace(/\\/g, '/').trim()).filter(Boolean))]
        : null
    if (explicit && !explicit.length) return partialResult(
        'HIGH — invalid change set\nfiles was provided but empty; pass repo-relative paths, or omit it to diff local changes.',
        'Explicit files list was empty.',
        'INVALID'
    )

    const graph = rawGraph(ctx)
    const providedDiff = typeof args.diff === 'string'
    let sourceLabel
    let classification
    if (providedDiff) {
        sourceLabel = explicit ? `from provided unified diff + ${explicit.length} file hint(s)` : 'from provided unified diff'
        classification = classifyChangeImpact({repoRoot: ctx.repoRoot, graph, diffText: args.diff, files: explicit || []})
    } else if (explicit) {
        sourceLabel = `for ${explicit.length} provided file(s) (no diff; conservative fallback)`
        classification = classifyChangeImpact({repoRoot: ctx.repoRoot, graph, files: explicit})
    } else {
        const base = resolveImpactBase(ctx.repoRoot, args.base ? String(args.base).trim() : '')
        if (!base) return partialResult(
            `HIGH — change impact unavailable\nCould not resolve base ref${args.base ? ` "${args.base}"` : ''}; pass base explicitly (for example origin/main or HEAD~1).`,
            'Base ref could not be resolved.'
        )
        const mergeBase = gitValue(ctx.repoRoot, ['merge-base', base, 'HEAD']) || base
        const untracked = gitLines(ctx.repoRoot, ['ls-files', '--others', '--exclude-standard']) || []
        sourceLabel = `vs ${base}${mergeBase !== base ? ` (merge-base ${mergeBase.slice(0, 12)})` : ''}`
        classification = classifyChangeImpact({repoRoot: ctx.repoRoot, graph, base: mergeBase, files: untracked})
    }

    if (!classification.files.length) return toolResult(`LOW — change impact ${sourceLabel}\nNo textual or untracked changes were found.`, {
        status: 'COMPLETE',
        verdict: 'LOW',
        reasons: classification.reasons,
        changes: [],
        seeds: {ids: [], unmappedIds: []},
        blastRadius: {impacted: 0, runtime: 0, compileTimeOnly: 0, nodes: []},
    }, {completeness: {status: 'COMPLETE'}})

    const changed = [...new Set(classification.files
        .flatMap((file) => [file.oldPath, file.newPath])
        .filter((file) => file && file !== '(diff unavailable)'))]
    const changedSet = new Set(changed)
    const seedIds = classification.seedIds.filter((id) => g.byId.has(String(id)))
    const seeds = new Set(seedIds)
    const unmappedSeedIds = classification.seedIds.filter((id) => !g.byId.has(String(id)))
    const unmappedFiles = classification.files
        .filter((file) => ![file.oldPath, file.newPath].some((path) => path && g.byId.has(String(path))))
        .map((file) => file.path)

    const maxDepth = Math.max(1, Math.min(4, Number(args.depth) || 2))
    const cap = Math.max(5, Math.min(120, Number(args.max_nodes) || 40))
    const reached = seeds.size ? reverseReach(g, seeds, maxDepth) : new Map()
    const impacted = [...reached.entries()]
        .filter(([id]) => !seeds.has(id) && !changedSet.has(fileOfNode(id)))
        .map(([id, entry]) => ({id, depth: entry.depth, entry, degree: degreeOf(g, id), file: fileOfNode(id)}))
        .sort((left, right) => left.depth - right.depth
            || Number(left.entry.compileOnly) - Number(right.entry.compileOnly)
            || right.degree - left.degree
            || left.id.localeCompare(right.id))

    // Measured coverage wins. Static reachability stays separately labelled and never becomes a
    // synthetic coverage percentage.
    const knownFiles = (graph.nodes || []).filter((node) => !String(node.id).includes('#') && node.source_file).map((node) => node.source_file)
    const coverage = readCoverageForRepo(ctx.repoRoot, knownFiles)
    const coverageOf = (file) => coverage.get(String(file).replace(/\\/g, '/'))?.pct ?? null
    const hasCoverage = coverage.size > 0
    const staticTests = computeStaticTestReachability(graph, {repoRoot: ctx.repoRoot})
    const staticByFile = new Map(staticTests.reachable.map((entry) => [entry.file, entry.nearestTests[0]]))
    const staticUnreachable = new Set(staticTests.unreachable)
    const testEvidenceFor = (file) => {
        const normalized = String(file).replace(/\\/g, '/')
        const actualCoverage = coverageOf(normalized)
        const nearest = staticByFile.get(normalized)
        return {
            actualCoverage,
            staticTestReachability: nearest ? {
                status: 'REACHABLE',
                test: nearest.test,
                distance: nearest.distance,
                confidence: nearest.confidence,
                path: nearest.path,
            } : staticUnreachable.has(normalized) ? {status: 'NO_PATH'} : {status: 'NOT_INDEXED'},
        }
    }
    const evidenceLabel = (file) => {
        const evidence = testEvidenceFor(file)
        if (evidence.actualCoverage != null) return `cov ${Math.round(evidence.actualCoverage * 100)}%`
        const reachability = evidence.staticTestReachability
        if (reachability.status === 'REACHABLE') return `static-test d${reachability.distance} ${reachability.confidence}`
        return reachability.status === 'NO_PATH' ? 'no static test path' : 'test evidence n/a'
    }

    const shown = impacted.slice(0, cap)
    const runtimeImpacted = impacted.filter((entry) => !entry.entry.compileOnly).length
    const compileImpacted = impacted.length - runtimeImpacted
    const coverageHotspots = hasCoverage
        ? shown.filter((node) => { const value = coverageOf(node.file); return value != null && value < 0.5 && node.degree >= 5 })
        : []
    const nodes = shown.map((node) => ({
        id: node.id,
        label: labelOf(g, node.id),
        file: node.file,
        depth: node.depth,
        kind: impactKind(node.entry),
        relation: node.entry.relation || 'rel',
        degree: node.degree,
        testEvidence: testEvidenceFor(node.file),
    }))
    const changeLines = classification.files.slice(0, 30).flatMap((file) => [
        `  [${file.classification}] ${file.path} — ${file.reason} (${file.seedIds.length} seed${file.seedIds.length === 1 ? '' : 's'})`,
        ...file.symbols.slice(0, 8).map((symbol) => `      ↳ [${symbol.classification}] ${symbol.label} [${symbol.id}]`),
    ])
    const warnings = []
    if (!classification.ok) warnings.push({code: 'CHANGE_CLASSIFICATION_PARTIAL', message: classification.reasons.join(' ')})
    if (unmappedFiles.length) warnings.push({code: 'CHANGED_FILES_UNMAPPED', message: `${unmappedFiles.length} changed file(s) are absent from the current graph.`})
    if (unmappedSeedIds.length) warnings.push({code: 'CHANGE_SEEDS_UNMAPPED', message: `${unmappedSeedIds.length} classified seed(s) are absent from the current graph.`})

    const text = [
        `${classification.verdict} — symbol-aware change impact ${sourceLabel}`,
        ...classification.reasons.map((reason) => `Reason: ${reason}`),
        `Changed evidence: ${classification.files.length} file(s), ${classification.summary.symbols} mapped symbol(s) → ${seeds.size} exact graph seed(s).`,
        ...changeLines,
        classification.files.length > 30 ? `  … +${classification.files.length - 30} more changed files` : null,
        '',
        impacted.length
            ? `Blast radius: ${impacted.length} impacted node(s) within ${maxDepth} reverse hop(s) (${runtimeImpacted} runtime, ${compileImpacted} compile-time-only), showing ${shown.length}:`
            : seeds.size ? `Blast radius: nothing else depends on the exact changed symbols within ${maxDepth} hop(s).` : `Blast radius: 0 — additive, metadata-only, and test-only changes do not inherit the containing file's legacy importers.`,
        hasCoverage
            ? 'Test evidence: measured coverage is shown where mapped; static reachability remains separate in structured output.'
            : `Test evidence: actualCoverage NOT_AVAILABLE; static paths only (${staticTests.reachableFiles}/${staticTests.productFiles} product files reachable from indexed tests).`,
        ...shown.map((node) => `  [d${node.depth} ${impactKind(node.entry)}] ${node.entry.relation || 'rel'}  ${labelOf(g, node.id)}  (deg ${node.degree}, ${evidenceLabel(node.file)})  [${node.id}]`),
        coverageHotspots.length ? '' : null,
        coverageHotspots.length ? 'Measured-coverage hotspots in the blast radius (<50%, deg ≥5):' : null,
        ...coverageHotspots.slice(0, 10).map((node) => `  ${labelOf(g, node.id)}  (cov ${Math.round(coverageOf(node.file) * 100)}%, deg ${node.degree})  ${node.file}`),
        '',
        'Drill into an impacted node with get_dependents/read_source; coverage_map distinguishes measured coverage from static reachability.',
    ].filter((line) => line != null).join('\n')

    const complete = classification.ok && !unmappedFiles.length && !unmappedSeedIds.length
    return toolResult(text, {
        status: complete ? 'COMPLETE' : 'PARTIAL',
        verdict: classification.verdict,
        reasons: classification.reasons,
        source: {label: sourceLabel, kind: classification.source},
        changes: classification.files,
        classification: {summary: classification.summary, bounds: classification.bounds},
        seeds: {ids: [...seeds].sort(), unmappedIds: unmappedSeedIds},
        blastRadius: {
            depth: maxDepth,
            impacted: impacted.length,
            runtime: runtimeImpacted,
            compileTimeOnly: compileImpacted,
            nodes,
        },
        testEvidence: {
            actualCoverage: hasCoverage ? 'AVAILABLE' : 'NOT_AVAILABLE',
            changedFiles: changed.slice(0, 500).map((file) => ({file, ...testEvidenceFor(file)})),
            staticTestReachability: {
                kind: staticTests.kind,
                testFiles: staticTests.testFiles,
                productFiles: staticTests.productFiles,
                reachableFiles: staticTests.reachableFiles,
                bounds: staticTests.bounds,
            },
        },
        unmappedFiles,
    }, {
        warnings,
        page: {shown: shown.length, total: impacted.length, capped: shown.length < impacted.length},
        completeness: {status: complete ? 'COMPLETE' : 'PARTIAL'},
    })
}
