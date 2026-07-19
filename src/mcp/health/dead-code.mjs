import {effectiveRawGraph} from '../graph-context.mjs'
import {computeDeadCodeReview} from '../../analysis/dead-code-review.js'
import {
  collectNonRuntimeRoots,
  collectPackageScopes,
  collectSourceTexts,
  readRepoJson,
} from '../../analysis/internal-audit.collect.js'
import {entryFiles} from '../../analysis/internal-audit.reach.js'
import {createPathClassifier} from '../../path-classification.js'
import {createRepoBoundary} from '../../repo-path.js'
import {readCachedSymbolPrecisionEvidence} from '../../precision/symbol-query.js'
import {toolResult} from '../tool-result.mjs'

export function tFindDeadCode(g, args, ctx) {
    if (!ctx.repoRoot) return 'Dead-code review needs the repo root (not provided to this server).'
    const effectiveGraph = effectiveRawGraph(ctx)
    const pointEvidence = readCachedSymbolPrecisionEvidence({repoRoot: ctx.repoRoot, graphPath: ctx.graphPath, graph: effectiveGraph})
    const graph = {
        ...effectiveGraph,
        precisionReferenceSymbols: [...new Set([
            ...(effectiveGraph.precisionReferenceSymbols || []),
            ...pointEvidence.referenceSymbols,
        ])],
        precisionProductionReferenceSymbols: [...new Set([
            ...(effectiveGraph.precisionProductionReferenceSymbols || []),
            ...pointEvidence.productionReferenceSymbols,
        ])],
        precisionTestReferenceSymbols: [...new Set([
            ...(effectiveGraph.precisionTestReferenceSymbols || []),
            ...pointEvidence.testReferenceSymbols,
        ])],
        precisionNoReferenceSymbols: [...new Set([
            ...(effectiveGraph.precisionNoReferenceSymbols || []),
            ...pointEvidence.noReferenceSymbols,
        ])],
    }
    const boundary = createRepoBoundary(ctx.repoRoot)
    const pkg = readRepoJson(boundary, 'package.json') || {}
    const rules = readRepoJson(boundary, '.weavatrix-deps.json') || {}
    const sources = collectSourceTexts(ctx.repoRoot, graph)
    const dynamicTargets = new Set((graph.externalImports || [])
        .filter((entry) => entry?.dynamic && entry?.target)
        .map((entry) => String(entry.target).replace(/\\/g, '/')))
    const frameworkEvidence = []
    const entries = entryFiles(graph, collectPackageScopes(ctx.repoRoot, pkg), dynamicTargets, {
        declaredEntries: rules.entrypoints || rules.entries || [],
        sources,
        conventionEvidence: frameworkEvidence,
    })
    for (const root of collectNonRuntimeRoots(ctx.repoRoot, rules)) {
        for (const file of sources.keys()) if (file === root || file.startsWith(`${root}/`)) entries.add(file)
    }

    const review = computeDeadCodeReview(graph, sources, {
        entrySet: entries,
        dynamicTargets,
        frameworkEvidence,
        pathClassifier: createPathClassifier(ctx.repoRoot),
        includeTests: args.include_tests === true,
        includeClassified: args.include_classified === true,
        minConfidence: args.min_confidence,
        path: args.path,
        kinds: args.kinds,
    })
    const max = Math.max(1, Math.min(100, Number(args.top_n) || 30))
    const shown = review.candidates.slice(0, max)
    const counts = review.totals.byConfidence
    const suppression = Object.entries(review.suppressed)
        .filter(([, count]) => count)
        .map(([name, count]) => `${name} ${count}`)
        .join(', ')
    const lines = shown.map((candidate, index) => {
        const subject = candidate.kind === 'file'
            ? candidate.file
            : `${candidate.owner ? `${candidate.owner}.` : ''}${candidate.symbol || candidate.id}`
        const where = `${candidate.file}${candidate.line ? `:${candidate.line}` : ''}`
        return [
            `${index + 1}. [${candidate.confidence}/${candidate.evidenceTier}/${candidate.classification}] ${subject} (${where})`,
            `     evidence: ${candidate.evidence.map((item) => item.fact).join(' ')}`,
            candidate.caveats.length ? `     caution: ${candidate.caveats.join(' ')}` : null,
            `     remaining: ${candidate.remainingChecks.join(' ')}`,
        ].filter(Boolean).join('\n')
    })
    const text = [
        `Dead-code review: ${shown.length} of ${review.candidates.length} candidate(s) shown (high ${counts.high}, medium ${counts.medium}, low ${counts.low}).`,
        `Evidence tiers: strong static ${review.totals.byEvidenceTier.strongStatic}, bounded static ${review.totals.byEvidenceTier.boundedStatic}, high uncertainty ${review.totals.byEvidenceTier.highUncertainty}.`,
        `Verdict: REVIEW_REQUIRED. This is static evidence, never permission to auto-delete or bulk-delete.`,
        suppression ? `Suppressed by current filters: ${suppression}.` : null,
        review.suppressed.confidence ? 'Use min_confidence=low only when public/framework/dynamic candidates need explicit review.' : null,
        '',
        ...(lines.length ? lines : ['No candidates matched the current production/path/kind/confidence filters.']),
        '',
        'Before removal: read_source, get_dependents, exact search, framework/config/manifest inspection, and the repository tests.',
    ].filter((line) => line != null).join('\n')
    return toolResult(text, {
        status: 'COMPLETE',
        verdict: 'REVIEW_REQUIRED',
        candidates: shown,
        totals: review.totals,
        suppressed: review.suppressed,
        repoSignals: review.repoSignals,
        policy: review.policy,
    }, {
        warnings: review.warnings,
        page: {shown: shown.length, total: review.candidates.length, capped: shown.length < review.candidates.length},
        completeness: {status: 'COMPLETE'},
    })
}

