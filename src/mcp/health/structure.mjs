import {degreeOf, rawGraph} from '../graph-context.mjs'
import {summarizeCommunities, aggregateGraph} from '../../analysis/graph-analysis.js'
import {computeStaticTestReachability} from '../../analysis/static-test-reachability.js'
import {computeHotPathReview} from '../../analysis/hot-path-review.js'
import {createPathClassifier, hasPathClass} from '../../path-classification.js'
import {toolResult} from '../tool-result.mjs'

export function tListCommunities(g, args, ctx) {
    const max = Math.max(1, Math.min(100, Number(args.top_n) || 20))
    const list = summarizeCommunities(ctx.graphPath, max)
    if (!list.length) return 'No communities found in the graph.'
    return [
        `Communities, largest first (list position = community_id for get_community):`,
        ...list.map((c, i) => `${String(i).padStart(3)}. ${c.name} — ${c.size} nodes (raw id ${c.id}; e.g. ${[...new Set(c.files)].join(', ')})`),
    ].join('\n')
}

// Folder-level architecture map: modules (top-two path segments) with file/symbol counts and the
// strongest module→module dependencies. Pure graph aggregation — no filesystem reads.
export function tModuleMap(g, args, ctx) {
    const graph = rawGraph(ctx)
    const testsOnly = graph.graphBuildMode === 'tests-only'
    const includeNonProduct = args.include_non_product === true || testsOnly
    const classifier = createPathClassifier(ctx?.repoRoot || null)
    const nonProductFiles = new Set()
    const classifiedFiles = new Set()
    if (!includeNonProduct) {
        for (const node of graph.nodes || []) {
            if (!node?.source_file) continue
            const sourceFile = String(node.source_file)
            if (classifiedFiles.has(sourceFile)) continue
            classifiedFiles.add(sourceFile)
            const explanation = classifier.explain(sourceFile)
            if (explanation.excluded || hasPathClass(explanation, 'test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp')) {
                nonProductFiles.add(sourceFile)
            }
        }
    }
    const visibleGraph = includeNonProduct || nonProductFiles.size === 0 ? graph : (() => {
        const keep = new Set((graph.nodes || [])
            .filter((node) => !node?.source_file || !nonProductFiles.has(String(node.source_file)))
            .map((node) => String(node.id)))
        const endpoint = (value) => String(value && typeof value === 'object' ? value.id : value)
        return {
            ...graph,
            nodes: (graph.nodes || []).filter((node) => keep.has(String(node.id))),
            links: (graph.links || []).filter((link) => keep.has(endpoint(link.source)) && keep.has(endpoint(link.target))),
        }
    })()
    const agg = aggregateGraph(visibleGraph, null)
    const topN = Math.max(1, Math.min(60, Number(args.top_n) || 25))
    const mods = agg.modules.slice(0, topN)
    const edges = agg.moduleEdges.slice(0, Math.min(50, topN * 2))
    const compileEdges = new Map()
    const collectCompileEdges = (list, kind) => {
        for (const edge of list || []) {
            const key = `${edge.from}\0${edge.to}`
            const current = compileEdges.get(key) || {from: edge.from, to: edge.to, count: 0, typeOnly: 0, compileOnly: 0}
            current.count += edge.count
            current[kind] += edge.count
            compileEdges.set(key, current)
        }
    }
    collectCompileEdges(agg.typeOnlyModuleEdges, 'typeOnly')
    collectCompileEdges(agg.compileOnlyModuleEdges, 'compileOnly')
    const compiled = [...compileEdges.values()].sort((a, b) => b.count - a.count).slice(0, Math.min(50, topN * 2))
    return [
        testsOnly
            ? 'Scope: tests-only graph; classified test/e2e/fixture surfaces are retained automatically.'
            : includeNonProduct
            ? 'Scope: all indexed files, including classified non-product surfaces.'
            : `Scope: production-only (default); excluded ${nonProductFiles.size} classified test/fixture/benchmark/generated/docs file(s). Pass include_non_product:true for the complete graph.`,
        `Module map: ${agg.totals.files} files in ${agg.modules.length} folder-modules, ${agg.totals.moduleEdges} runtime module dependencies and ${agg.totals.compileTimeModuleEdges || 0} compile-time dependencies (${agg.totals.typeOnlyModuleEdges || 0} type-only, ${agg.totals.compileOnlyModuleEdges || 0} compile-only). Top ${mods.length}:`,
        ...mods.map((m) => `  ${m.name} — ${m.fileCount} files, ${m.symbolCount} symbols`),
        ``,
        `Strongest runtime module dependencies:`,
        ...edges.map((e) => `  ${e.from} → ${e.to}  (${e.count})`),
        compiled.length ? `` : null,
        compiled.length ? `Compile-time module dependencies (not runtime coupling):` : null,
        ...compiled.map((e) => `  ${e.from} → ${e.to}  (${e.count}; ${e.typeOnly} type-only, ${e.compileOnly} compile-only)`),
    ].filter((line) => line != null).join('\n')
}

// Parser-backed local cost review. This keeps syntax, graph coupling and measured/static test
// evidence as separate fields so callers cannot mistake a ranking heuristic for profiler output.
export function tHotPathReview(g, args, ctx) {
    const review = computeHotPathReview(rawGraph(ctx), {
        repoRoot: ctx?.repoRoot || null,
        path: args.path,
        includeTests: args.include_tests === true,
        includeClassified: args.include_classified === true,
        topN: args.top_n,
        cyclomaticThreshold: args.cyclomatic_threshold,
        callThreshold: args.call_threshold,
        loopDepthThreshold: args.loop_depth_threshold,
        timeRankThreshold: args.time_rank_threshold,
        minScore: args.min_score,
    })
    if (!review.ok) return toolResult(`Hot-path review refused: ${review.error}.`, review)
    const pct = (value) => typeof value === 'number' ? `${Math.round(value * 100)}%` : String(value || 'NOT_AVAILABLE')
    const coverageLine = review.coverage.actualCoverage === 'AVAILABLE'
        ? `Measured coverage: ${review.coverage.measuredFiles} file(s) from ${review.coverage.sources.join(', ') || 'coverage report'}.`
        : review.coverage.staticReachability
            ? `actualCoverage: NOT_AVAILABLE; static test reachability ${review.coverage.staticReachability.reachableFiles}/${review.coverage.staticReachability.productFiles} product file(s).`
            : 'actualCoverage: NOT_AVAILABLE; no measured or static test evidence was available.'
    const text = [
        `Local hot-path review: ${review.candidateSymbols} candidate(s) from ${review.analyzedSymbols} analyzed symbol(s); showing ${review.hotspots.length}.`,
        `Thresholds: time rank >=${review.thresholds.timeRank}, cyclomatic >=${review.thresholds.cyclomatic}, calls >=${review.thresholds.calls}, loop depth >=${review.thresholds.loopDepth}, score >=${review.thresholds.minScore}.`,
        `Selection: ${review.selectionPolicy.mode}${review.selectionPolicy.strongLocalFallback ? '; strong local sort/recursion/deep-loop evidence can pass below the blended score gate' : '; strict explicit score gate'}.`,
        coverageLine,
        'Local syntax cost and graph coupling are separate. Scores are review priority, not measured runtime.',
        '',
        ...(review.hotspots.length ? review.hotspots.flatMap((item, index) => {
            const tests = item.testEvidence.actualCoverage === 'NOT_AVAILABLE'
                ? item.testEvidence.staticReachable ? `static-test d${item.testEvidence.distance}` : 'no-static-test-path'
                : `coverage ${pct(item.testEvidence.actualCoverage)}`
            const pointer = `${item.file}${item.startLine ? `:${item.startLine}${item.endLine > item.startLine ? `-${item.endLine}` : ''}` : ''}`
            const evidence = item.sourceEvidence.length
                ? `\n       evidence: ${item.sourceEvidence.map((entry) => `${entry.kind}@L${entry.line || '?'}${entry.detail ? ` (${entry.detail})` : ''}`).join('; ')}`
                : ''
            return [
                `  ${String(index + 1).padStart(2)}. score ${String(item.score).padStart(5)}  syntax ${String(item.localSyntax.score).padStart(5)}  graph ${String(item.graphRisk.score).padStart(5)}  ${item.confidence}`,
                `      ${item.label}  (${pointer}; fan-in ${item.graphRisk.fanIn}, fan-out ${item.graphRisk.fanOut}; ${tests})`,
                `       ${item.reasons.slice(0, 5).join('; ')}${evidence}`,
            ]
        }) : ['  (none at the selected thresholds)']),
        review.bounds.truncated ? `... +${review.bounds.totalCandidates - review.bounds.returned} more (raise top_n to display more, raise min_score or narrow path to tighten; lower min_score to broaden).` : null,
        '',
        'Caveat: no interprocedural Big-O, recursion-bound, CFG, dead-store or taint-flow claim is made.',
    ].filter((line) => line != null).join('\n')
    return toolResult(text, review, {
        completeness: {
            symbols: 'COMPLETE_FOR_INDEXED_GRAPH',
            output: review.bounds.truncated ? 'BOUNDED' : 'COMPLETE',
            coverage: review.coverage.actualCoverage,
        },
    })
}

// Coverage × graph: map an EXISTING coverage report (istanbul/lcov/coverage.py/Go — read offline,
// tests are never executed here) onto files and symbols, then rank refactor risk as
// connectivity × uncovered share. Pairs with get_dependents: many dependents + low coverage ⇒ write
// tests before changing. Coverage pcts in this layer are fractions (0..1).
export function tCoverageMap(g, args, ctx) {
    if (!ctx.repoRoot) return 'Coverage mapping needs the repo root (not provided to this server).'
    const agg = aggregateGraph(rawGraph(ctx), ctx.repoRoot)
    const pathFilter = args.path ? String(args.path).replace(/\\/g, '/').replace(/\/+$/, '') : null
    const inScope = (p) => !pathFilter || p === pathFilter || String(p).startsWith(`${pathFilter}/`)
    const allFiles = agg.modules.flatMap((m) => m.files.filter((f) => inScope(f.path)))
    const measured = allFiles.filter((f) => f.coverage != null)
    if (!measured.length) {
        const fallback = computeStaticTestReachability(rawGraph(ctx), {repoRoot: ctx.repoRoot, path: pathFilter || ''})
        const topN = Math.max(1, Math.min(50, Number(args.top_n) || 15))
        const reachable = fallback.reachable.slice(0, topN)
        const unreachable = fallback.unreachable.slice(0, topN)
        return [
            `Static test reachability${pathFilter ? ` for ${pathFilter}` : ''}: ${fallback.reachableFiles}/${fallback.productFiles} product file(s) have a runtime graph path from ${fallback.testFiles} indexed test file(s).`,
            `actualCoverage: ${fallback.actualCoverage}. This is NOT coverage: imports/calls only show that a test can statically reach a file, never that a line, branch or symbol executed.`,
            fallback.bounds.truncated ? `Traversal was bounded/truncated (${fallback.bounds.traversedStates}/${fallback.bounds.maxStates} states, depth ≤${fallback.bounds.maxDepth}, ${fallback.testFiles}/${fallback.totalTestFiles} test files).` : `Traversal: ${fallback.bounds.traversedStates} bounded state(s), depth ≤${fallback.bounds.maxDepth}.`,
            '',
            'Nearest runtime paths from tests:',
            ...(reachable.length ? reachable.map((entry) => {
                const nearest = entry.nearestTests[0]
                return `  ${nearest.confidence.padStart(6)}  d${nearest.distance}  ${entry.file}  ← ${nearest.test}\n          path: ${nearest.path.join(' → ')}`
            }) : ['  (none)']),
            '',
            `No runtime path from an indexed test (${fallback.unreachableFiles}; not proof of no tests):`,
            ...(unreachable.length ? unreachable.map((file) => `  ${file}`) : ['  (none)']),
            fallback.unreachableFiles > unreachable.length ? `  … +${fallback.unreachableFiles - unreachable.length} more (raise top_n or narrow path)` : null,
            '',
            'No coverage report found — generate one for measured coverage:',
            'Generate one with the repo\'s own test runner, then call coverage_map again:',
            '  JS/TS:  npx vitest run --coverage   (or jest --coverage)',
            '  Python: pytest --cov --cov-report=json',
            '  Go:     go test ./... -coverprofile=coverage.out',
            'Read locations: coverage/coverage-summary.json, coverage/coverage-final.json, (coverage/)lcov.info, coverage.json, coverage.out.',
        ].filter((line) => line != null).join('\n')
    }
    const pctStr = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`)
    const sources = [...new Set(measured.map((f) => f.coverageSource).filter(Boolean))]
    const avg = measured.reduce((s, f) => s + f.coverage, 0) / measured.length
    const rollup = agg.modules
        .map((m) => {
            const withCov = m.files.filter((f) => f.coverage != null && inScope(f.path))
            if (!withCov.length) return null
            return {
                name: m.name,
                measured: withCov.length,
                total: m.files.filter((f) => inScope(f.path)).length,
                avg: withCov.reduce((s, f) => s + f.coverage, 0) / withCov.length,
            }
        })
        .filter(Boolean)
        .sort((a, b) => a.avg - b.avg)
    const topN = Math.max(1, Math.min(50, Number(args.top_n) || 15))
    // risk = graph degree × uncovered share; only symbols below 80% matter
    const risky = agg.symbols
        .filter((s) => s.coverage != null && s.coverage < 0.8 && inScope(s.file))
        .map((s) => ({...s, degree: degreeOf(g, s.id)}))
        .filter((s) => s.degree > 0)
        .sort((a, b) => b.degree * (1 - b.coverage) - a.degree * (1 - a.coverage))
        .slice(0, topN)
    return [
        `Coverage map (${measured.length}/${allFiles.length} files measured, avg ${pctStr(avg)}; report: ${sources.join(', ') || 'unknown'}${pathFilter ? `; filter ${pathFilter}` : ''}).`,
        ``,
        `Modules by average coverage (worst first):`,
        ...rollup.slice(0, 20).map((m) => `  ${pctStr(m.avg).padStart(5)}  ${m.name}  (${m.measured}/${m.total} files measured)`),
        ``,
        `Refactor-risk hotspots — connected symbols with low coverage (ranked by degree × uncovered):`,
        ...(risky.length
            ? risky.map((s) => `  ${pctStr(s.coverage).padStart(5)}  deg ${String(s.degree).padStart(3)}  ${s.label}  (${s.file}${s.line ? `:${s.line}` : ''})`)
            : ['  (none — every connected symbol is ≥80% covered or unmeasured)']),
        ``,
        `Tip: before refactoring a hotspot, run get_dependents on it — low coverage × many dependents means write tests first.`,
    ].join('\n')
}

// HTTP endpoint inventory: Express/Fastify/Nest/Flask/FastAPI/Go/Rust/Spring route definitions.

