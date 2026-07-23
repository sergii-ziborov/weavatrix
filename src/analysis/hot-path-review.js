// Bounded local hot-path review over parser-derived complexity facts. This deliberately keeps
// local syntax cost, graph coupling and test evidence separate: it is a review queue, not a runtime
// profiler or an interprocedural Big-O proof.
import {readCoverageForRepo, normalizeRepoParts} from './coverage-reports.js'
import {computeStaticTestReachability} from './static-test-reachability.js'
import {createPathClassifier, hasPathClass} from '../path-classification.js'
import {isStructuralRelation} from '../graph/relations.js'
import {boundedInteger} from '../util.js'

const NON_PRODUCT = ['generated', 'vendored', 'mock', 'story', 'docs', 'benchmark', 'temp']
const endpoint = (value) => String(value && typeof value === 'object' ? value.id : value || '')
const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
const boundedInt = boundedInteger
const round = (value) => Math.round(Number(value || 0) * 100) / 100
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0))

function normalizeScope(value) {
    const path = normalize(value)
    if (!path) return {ok: true, path: ''}
    if (path.includes('\0') || /^[a-z]:\//i.test(path) || path.startsWith('/') || path.split('/').includes('..')) {
        return {ok: false, error: 'path must be repository-relative and cannot contain traversal segments'}
    }
    return {ok: true, path}
}

function coverageForRange(record, startLine, endLine) {
    if (!record) return null
    if (!(record.lines instanceof Map) || !record.lines.size) return Number.isFinite(record.pct) ? record.pct : null
    let total = 0
    let covered = 0
    for (let line = Math.max(1, startLine); line <= Math.max(startLine, endLine); line++) {
        if (!record.lines.has(line)) continue
        total++
        if (Number(record.lines.get(line)) > 0) covered++
    }
    return total ? covered / total : Number.isFinite(record.pct) ? record.pct : null
}

function graphRiskBySymbol(graph, symbolIds, testCallerIds) {
    const state = new Map([...symbolIds].map((id) => [id, {
        incoming: 0, outgoing: 0, callers: new Set(), callees: new Set(),
    }]))
    for (const link of graph?.links || []) {
        if (!link || link.typeOnly === true || link.compileOnly === true || link.barrelProxy === true || isStructuralRelation(link.relation)) continue
        const source = endpoint(link.source)
        const target = endpoint(link.target)
        if (!source || !target || source === target) continue
        if (state.has(source)) {
            const item = state.get(source)
            item.outgoing++
            item.callees.add(target)
        }
        // A test caller (inline #[cfg(test)] symbol or a test-path file) must not inflate a production
        // symbol's fan-in — the same reason test symbols are excluded as candidates. Skipped only for the
        // incoming/coupling side; unless the caller opted tests in (testCallerIds is then null).
        if (state.has(target) && !(testCallerIds && testCallerIds.has(source))) {
            const item = state.get(target)
            item.incoming++
            item.callers.add(source)
        }
    }
    return new Map([...state].map(([id, item]) => [id, {
        fanIn: item.callers.size,
        fanOut: item.callees.size,
        incomingEdges: item.incoming,
        outgoingEdges: item.outgoing,
    }]))
}

function localSyntaxScore(complexity, thresholds) {
    const insideLoop = Number(complexity.allocationsInLoops || 0)
        + Number(complexity.copiesInLoops || 0)
        + Number(complexity.linearOpsInLoops || 0)
        + Number(complexity.sortsInLoops || 0) * 2
        + Number(complexity.recursionInLoops || 0) * 2
    const score = Number(complexity.timeRank || 0) * 12
        + Number(complexity.memoryRank || 0) * 5
        + Math.min(18, Number(complexity.cyclomatic || 1) / thresholds.cyclomatic * 10)
        + Math.min(12, Number(complexity.callCount || 0) / thresholds.calls * 6)
        + Math.min(18, Number(complexity.maxLoopDepth || 0) * 5)
        + Math.min(24, insideLoop * 5)
        + (complexity.recursion ? 6 : 0)
    return round(clamp(score))
}

function couplingScore(risk) {
    return round(clamp(Math.log2(1 + risk.fanIn) * 20 + Math.log2(1 + risk.fanOut) * 10))
}

function reasonsFor(complexity, thresholds) {
    const reasons = []
    if (Number(complexity.timeRank || 0) >= thresholds.timeRank) reasons.push(String(complexity.timeLabel || `local time rank ${complexity.timeRank}`))
    if (Number(complexity.cyclomatic || 0) >= thresholds.cyclomatic) reasons.push(`cyclomatic ${complexity.cyclomatic} >= ${thresholds.cyclomatic}`)
    if (Number(complexity.callCount || 0) >= thresholds.calls) reasons.push(`${complexity.callCount} local call sites >= ${thresholds.calls}`)
    if (Number(complexity.maxLoopDepth || 0) >= thresholds.loopDepth) reasons.push(`loop depth ${complexity.maxLoopDepth} >= ${thresholds.loopDepth}`)
    if (complexity.allocationsInLoops) reasons.push(`${complexity.allocationsInLoops} allocation(s) inside iteration`)
    if (complexity.copiesInLoops) reasons.push(`${complexity.copiesInLoops} copy/copies inside iteration`)
    if (complexity.linearOpsInLoops) reasons.push(`${complexity.linearOpsInLoops} linear operation(s) inside iteration`)
    if (complexity.sortsInLoops) reasons.push(`${complexity.sortsInLoops} sort(s) inside iteration`)
    if (complexity.recursionInLoops) reasons.push(`${complexity.recursionInLoops} recursive call(s) inside iteration`)
    if (complexity.recursion) reasons.push('direct recursion; bound remains unknown')
    return [...new Set(reasons)].slice(0, 12)
}

export function computeHotPathReview(graph, options = {}) {
    const scope = normalizeScope(options.path)
    if (!scope.ok) return {ok: false, error: scope.error}
    const thresholds = {
        cyclomatic: boundedInt(options.cyclomaticThreshold, 8, 2, 1000),
        calls: boundedInt(options.callThreshold, 12, 1, 10000),
        loopDepth: boundedInt(options.loopDepthThreshold, 2, 1, 10),
        timeRank: boundedInt(options.timeRankThreshold, 2, 0, 5),
        minScore: boundedInt(options.minScore, 85, 0, 100),
    }
    const defaultFocus = options.minScore == null
    const topN = boundedInt(options.topN, 20, 1, 100)
    const classifier = createPathClassifier(options.repoRoot || null)
    const knownFiles = [...new Set((graph?.nodes || []).map((node) => normalize(node?.source_file)).filter(Boolean))]
    const measuredCoverage = options.repoRoot ? readCoverageForRepo(options.repoRoot, knownFiles) : new Map()
    const coverageSources = [...new Set([...measuredCoverage.values()].map((item) => item?.source).filter(Boolean))].sort()
    const staticTests = measuredCoverage.size || !options.repoRoot
        ? null
        : computeStaticTestReachability(graph, {repoRoot: options.repoRoot, path: scope.path})
    const staticByFile = new Map((staticTests?.reachable || []).map((item) => [normalize(item.file), item]))

    const eligible = []
    const excluded = {tests: 0, classified: 0, outOfScope: 0}
    for (const node of graph?.nodes || []) {
        const complexity = node?.complexity
        const file = normalize(node?.source_file)
        if (!complexity || !file || !String(node?.id || '').includes('#')) continue
        if (scope.path && file !== scope.path && !file.startsWith(`${scope.path}/`)) { excluded.outOfScope++; continue }
        const classification = classifier.explain(file)
        const test = node?.test_surface === true || hasPathClass(classification, 'test', 'e2e')
        const classified = classification.excluded || hasPathClass(classification, ...NON_PRODUCT)
        if (test && options.includeTests !== true) { excluded.tests++; continue }
        if (classified && options.includeClassified !== true) { excluded.classified++; continue }
        eligible.push({node, complexity, file, classification: test ? 'test' : classified ? 'classified' : 'production'})
    }

    // Test callers (inline test_surface symbols and test-path files) that must not count toward a
    // production symbol's fan-in. Built over ALL nodes because a caller may sit outside the review scope.
    const testCallerIds = options.includeTests === true ? null : (() => {
        const ids = new Set()
        const classifyCache = new Map()
        for (const node of graph?.nodes || []) {
            const id = String(node?.id || '')
            if (!id.includes('#')) continue
            let isTest = node?.test_surface === true
            const file = normalize(node?.source_file)
            if (!isTest && file) {
                let info = classifyCache.get(file)
                if (info === undefined) classifyCache.set(file, (info = classifier.explain(file)))
                isTest = hasPathClass(info, 'test', 'e2e')
            }
            if (isTest) ids.add(id)
        }
        return ids
    })()
    const riskById = graphRiskBySymbol(graph, new Set(eligible.map(({node}) => String(node.id))), testCallerIds)
    const candidates = []
    for (const entry of eligible) {
        const {node, complexity, file} = entry
        const reasons = reasonsFor(complexity, thresholds)
        if (!reasons.length) continue
        const risk = riskById.get(String(node.id)) || {fanIn: 0, fanOut: 0, incomingEdges: 0, outgoingEdges: 0}
        const syntaxScore = localSyntaxScore(complexity, thresholds)
        const graphScore = couplingScore(risk)
        const startLine = Number(complexity.startLine) || Number(String(node.source_location || '').replace(/^L/, '')) || 0
        const endLine = Number(complexity.endLine) || Number(String(node.source_end || '').replace(/^L/, '')) || startLine
        const coverageRecord = measuredCoverage.get(normalizeRepoParts(file)) || null
        const actualCoverage = coverageForRange(coverageRecord, startLine, endLine)
        const nearest = staticByFile.get(file)?.nearestTests?.[0] || null
        const coverageRisk = actualCoverage == null ? 0 : (1 - actualCoverage) * 100
        const score = round(clamp(syntaxScore * 0.72 + graphScore * 0.2 + coverageRisk * 0.08))
        const directHotEvidence = Array.isArray(complexity.hotEvidence) ? complexity.hotEvidence.slice(0, 12) : []
        // The default queue is intentionally narrow. A small, locally expensive function can still be
        // important even with little graph fan-in, so retain only a bounded strong-local fallback. An
        // explicit minScore disables this fallback and gives the caller a strict numeric gate.
        const bodyLines = startLine > 0 && endLine >= startLine ? endLine - startLine + 1 : Number.POSITIVE_INFINITY
        const strongLocalEvidence = defaultFocus && directHotEvidence.length > 0 && bodyLines <= 80 && (
            Number(complexity.recursionInLoops || 0) > 0
            || (bodyLines <= 40 && (
                Number(complexity.sortsInLoops || 0) > 0
                || (Number(complexity.timeRank || 0) >= 4 && Number(complexity.maxLoopDepth || 0) >= 2)
            ))
        )
        if (score < thresholds.minScore && !strongLocalEvidence) continue
        const confidence = directHotEvidence.length ? 'HIGH' : complexity.recursion ? 'LOW' : 'MEDIUM'
        candidates.push({
            id: String(node.id),
            label: String(node.label || node.norm_label || node.id),
            kind: String(node.symbol_kind || 'symbol'),
            file,
            startLine,
            endLine,
            classification: entry.classification,
            score,
            selection: score >= thresholds.minScore ? 'SCORE_THRESHOLD' : 'STRONG_LOCAL_EVIDENCE',
            confidence,
            localSyntax: {
                score: syntaxScore,
                timeRank: Number(complexity.timeRank || 0),
                timeLabel: String(complexity.timeLabel || ''),
                memoryRank: Number(complexity.memoryRank || 0),
                memoryLabel: String(complexity.memoryLabel || ''),
                cyclomatic: Number(complexity.cyclomatic || 0),
                calls: Number(complexity.callCount || 0),
                loops: Number(complexity.loops || 0),
                maxLoopDepth: Number(complexity.maxLoopDepth || 0),
                allocationsInLoops: Number(complexity.allocationsInLoops || 0),
                copiesInLoops: Number(complexity.copiesInLoops || 0),
                linearOpsInLoops: Number(complexity.linearOpsInLoops || 0),
                sortsInLoops: Number(complexity.sortsInLoops || 0),
                recursionInLoops: Number(complexity.recursionInLoops || 0),
                recursion: complexity.recursion === true,
            },
            graphRisk: {...risk, score: graphScore},
            testEvidence: actualCoverage != null
                ? {actualCoverage, source: coverageRecord?.source || 'coverage report'}
                : nearest
                    ? {actualCoverage: 'NOT_AVAILABLE', staticReachable: true, nearestTest: nearest.test, distance: nearest.distance, confidence: nearest.confidence}
                    : {actualCoverage: 'NOT_AVAILABLE', staticReachable: false},
            reasons,
            sourceEvidence: directHotEvidence,
        })
    }
    candidates.sort((left, right) => right.score - left.score
        || right.localSyntax.score - left.localSyntax.score
        || right.graphRisk.fanIn - left.graphRisk.fanIn
        || left.id.localeCompare(right.id))
    const hotspots = candidates.slice(0, topN)
    return {
        ok: true,
        modelVersion: 1,
        complexityVersion: Number(graph?.complexityV) || 0,
        scope: {
            path: scope.path || null,
            includeTests: options.includeTests === true,
            includeClassified: options.includeClassified === true,
        },
        thresholds,
        selectionPolicy: {
            mode: defaultFocus ? 'FOCUSED_DEFAULT' : 'EXPLICIT_SCORE_THRESHOLD',
            strongLocalFallback: defaultFocus,
            broadenWith: 'Set min_score lower (0 restores the full diagnostic candidate set).',
        },
        analyzedSymbols: eligible.length,
        candidateSymbols: candidates.length,
        coverage: measuredCoverage.size
            ? {actualCoverage: 'AVAILABLE', measuredFiles: measuredCoverage.size, sources: coverageSources}
            : {actualCoverage: 'NOT_AVAILABLE', staticReachability: staticTests ? {
                reachableFiles: staticTests.reachableFiles,
                productFiles: staticTests.productFiles,
                truncated: staticTests.bounds.truncated,
            } : null},
        excluded,
        hotspots,
        bounds: {topN, returned: hotspots.length, totalCandidates: candidates.length, truncated: candidates.length > hotspots.length},
        caveats: [
            'Scores rank parser-derived local syntax cost; they are not profiler measurements.',
            'Graph risk is reported separately and does not propagate loop complexity through callees.',
            'Recursion bounds, CFG reachability, dead stores and taint flow are not inferred by this model.',
        ],
    }
}
