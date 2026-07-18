// Health tools: clone detection, the internal audit, community/module overviews, coverage mapping
// and the HTTP endpoint inventory. Hot-reloadable (re-imported by catalog.mjs on change).
import {spawnSync} from 'node:child_process'
import {degreeOf, rawGraph, effectiveRawGraph} from './graph-context.mjs'
import {computeDuplicates} from '../analysis/duplicates.js'
import {analyzeDuplicateGroups} from '../analysis/duplicate-groups.js'
import {runInternalAudit} from '../analysis/internal-audit.js'
import {classifyChangeImpact} from '../analysis/change-classification.js'
import {compareAuditDebt, normalizeAuditScopeFiles, scopeAuditFindings} from '../analysis/audit-debt.js'
import {summarizeFindings} from '../analysis/findings.js'
import {summarizeCommunities, aggregateGraph} from '../analysis/graph-analysis.js'
import {analyzeEndpointInventory} from '../analysis/endpoints.js'
import {computeStaticTestReachability} from '../analysis/static-test-reachability.js'
import {computeDeadCodeReview} from '../analysis/dead-code-review.js'
import {computeHotPathReview} from '../analysis/hot-path-review.js'
import {collectNonRuntimeRoots, collectPackageScopes, collectSourceTexts, readRepoJson} from '../analysis/internal-audit.collect.js'
import {entryFiles} from '../analysis/internal-audit.reach.js'
import {buildInternalGraph} from '../graph/internal-builder.js'
import {resolveGitCommit, withGitRefCheckout} from '../analysis/git-ref-graph.js'
import {childProcessEnv} from '../child-env.js'
import {toolResult} from './tool-result.mjs'
import {createPathClassifier, hasPathClass} from '../path-classification.js'
import {createRepoBoundary} from '../repo-path.js'
import {filterGraphForMode} from '../graph/graph-filter.js'
import {readCachedSymbolPrecisionEvidence} from '../precision/symbol-query.js'

const NON_PRODUCT_DUPLICATE_CLASSES = new Set(['generated', 'mock', 'story', 'docs', 'benchmark', 'temp'])
const fragmentEligible = (fragment, {tokMin, skipTests, includeClassified}) => {
    if (fragment.n < tokMin) return false
    const classes = new Set(fragment.classes || [])
    if (skipTests && (fragment.test || classes.has('test') || classes.has('e2e'))) return false
    if (!includeClassified && (fragment.excluded || [...classes].some((name) => NON_PRODUCT_DUPLICATE_CLASSES.has(name)))) return false
    return true
}

export function tFindDuplicates(g, args, ctx) {
    if (!ctx.repoRoot) return 'Duplicate scan needs the repo root (not provided to this server).'
    const simMin = Math.min(100, Math.max(50, Number(args.min_similarity) || 80))
    const tokMin = Math.min(400, Math.max(12, Number(args.min_tokens) || 50))
    const mode = args.mode === 'strict' ? 'strict' : 'renamed'
    const skipTests = args.include_tests ? false : true
    const includeClassified = args.include_classified === true || args.include_non_product === true
    const includeStrings = !!args.include_strings
    // semantic mode: same-name symbols across files, ranked by size — LOW similarity is the signal
    // (same name, drifted behavior). Token-clone pairing is skipped entirely.
    if (args.mode === 'semantic') {
        const data = computeDuplicates(ctx.repoRoot, ctx.graphPath, {nameTwins: true, minTokens: tokMin})
        const frags = data.frags
        const candidates = []
        for (const twin of data.nameTwins || []) {
            const allowed = new Set(twin.members.filter((i) => fragmentEligible(frags[i], {tokMin, skipTests, includeClassified})))
            const pairs = (twin.pairs || []).filter((p) => allowed.has(p.a) && allowed.has(p.b))
            if (!pairs.length) continue
            const closest = pairs.slice().sort((a, b) => b.similarity - a.similarity)[0]
            const farthest = pairs.slice().sort((a, b) => a.similarity - b.similarity)[0]
            if (closest.similarity >= 85) candidates.push({kind: 'clone', label: twin.label, pair: closest})
            if (farthest.similarity <= 45) candidates.push({kind: 'collision', label: twin.label, pair: farthest})
        }
        for (const item of candidates) item.tokens = frags[item.pair.a].n + frags[item.pair.b].n
        candidates.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'clone' ? -1 : 1
            return a.kind === 'clone'
                ? b.pair.similarity - a.pair.similarity || b.tokens - a.tokens
                : b.tokens - a.tokens || a.pair.similarity - b.pair.similarity
        })
        if (!candidates.length) return 'No actionable same-name pairs across files (semantic mode; ambiguous middle-similarity pairs are suppressed).'
        const top = candidates.slice(0, Math.min(30, Math.max(1, Number(args.top_n) || 15)))
        const lines = top.map((item, k) => {
            const a = frags[item.pair.a]
            const b = frags[item.pair.b]
            const verdict = item.kind === 'clone'
                ? 'near-identical duplicate candidate — review, then extract shared logic if the contract is truly shared'
                : 'name collision, not a duplicate — inspect only if these definitions should share a contract'
            return [
                `${k + 1}. "${item.label}" — ${item.pair.similarity}% similar; ${verdict}`,
                `     ${a.file}:${a.start}-${a.end}  (${a.n} tok)`,
                `     ${b.file}:${b.start}-${b.end}  (${b.n} tok)`,
            ].join('\n')
        })
        return `Found ${candidates.length} actionable same-name pair(s) across files (semantic mode; one closest clone and/or farthest collision per name). Top ${top.length}:\n\n${lines.join('\n\n')}\n\nThese are review candidates, not automatic refactors. Use read_source on both sites before changing code.`
    }
    const analysis = analyzeDuplicateGroups(ctx.repoRoot, ctx.graphPath, args)
    const groups = analysis.groups
    const smallPolicy = tokMin < 30 ? ' Small fragments below 30 tokens require at least 95% similarity and two shared bounded fingerprints.' : ''
    const suppressed = analysis.suppressed
    const suppressionNote = suppressed && !includeClassified
        ? ` ${suppressed} fragment(s) classified as tests/e2e/generated/mock/story/docs/benchmark/temp or matched by .weavatrix.json exclude were suppressed; pass include_classified:true (and include_tests:true for tests) to inspect them explicitly.`
        : ''
    const boilerplateNote = analysis.boilerplateSuppressed
        ? ` ${analysis.boilerplateSuppressed} all-router framework boilerplate group(s) were suppressed; pass include_boilerplate:true to inspect them.`
        : ''
    if (!groups.length) return `No clones at ≥${simMin}% similarity / ≥${tokMin} tokens (${mode} mode). Try lowering the thresholds.${smallPolicy}${suppressionNote}${boilerplateNote}`
    const top = groups.slice(0, Math.min(30, Math.max(1, Number(args.top_n) || 15)))
    const lines = top.map((grp, k) => {
        const isStr = grp.members.some((f) => f.kind === 'string')
        const head = `${k + 1}. ${grp.members.length}× "${grp.members[0].label}"${isStr ? ' [string literal]' : ''} — ≤${grp.maxSim}% similar, ${grp.tokens} duplicated tokens`
        const sites = grp.members.slice(0, 8).map((f) => `     ${f.file}:${f.start}-${f.end}`)
        return [head, ...sites].join('\n')
    })
    return `Found ${groups.length} clone group(s) (${mode} mode, ≥${simMin}%, ≥${tokMin} tok${includeStrings ? ', incl. large string literals' : ''}). Top ${top.length}:\n\n${lines.join('\n\n')}\n\nUse read_source on any two sites to compare, then extract shared logic.${smallPolicy}${suppressionNote}${boilerplateNote}`
}

// Focused dead-code review queue. Unlike the broad run_audit surface, this includes functions and
// methods with bounded source-free evidence, and explicitly demotes framework/dynamic/public API
// candidates. It never returns an automatic-delete verdict.
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

const SEVERITY_RANK = {critical: 0, high: 1, medium: 2, low: 3, info: 4}
const AUDIT_NON_PRODUCT_CLASSES = ['test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp']

export function formatAuditFinding(f) {
    const where = f.file ? `  (${f.file}${f.symbol ? ` ${f.symbol}` : ''})` : f.package ? `  (pkg ${f.package}${f.version ? `@${f.version}` : ''}${f.manifest ? `; ${f.manifest}` : ''})` : ''
    const verification = f.verification?.evidenceModel
        ? `\n      verification: ${f.verification.evidenceModel}; manifest ${f.verification.manifestDeclaration?.status || 'N/A'}; indexed imports ${f.verification.indexedSourceImports?.status || 'N/A'}; decision ${f.verification.decision || 'REVIEW_REQUIRED'}`
        : ''
    return `  [${f.severity}/${f.confidence || '?'}] ${f.rule}: ${f.title}${where}${f.reason ? `\n      reason: ${f.reason}` : ''}${verification}${f.cycleRoute ? `\n      route: ${f.cycleRoute}` : ''}${f.fixHint ? `\n      fix: ${f.fixHint}` : ''}`
}

const auditFindingPaths = (finding) => {
    const paths = []
    if (finding?.file) paths.push(String(finding.file))
    if (Array.isArray(finding?.files)) paths.push(...finding.files.map(String))
    if (finding?.cycleRoute) paths.push(...String(finding.cycleRoute).split(/\s*(?:→|â†’|->)\s*/))
    return [...new Set(paths.map((file) => file.replace(/\\/g, '/').trim()).filter(Boolean))]
}

export function auditFindingPathScope(findings, {includeClassified = false, repoRoot = null} = {}) {
    const all = Array.isArray(findings) ? findings : []
    if (includeClassified) return {findings: all, suppressed: 0}
    const classifier = createPathClassifier(repoRoot)
    const cache = new Map()
    const classified = (file) => {
        if (!cache.has(file)) cache.set(file, classifier.explain(file, {content: ''}))
        const info = cache.get(file)
        return info?.excluded || AUDIT_NON_PRODUCT_CLASSES.some((name) => hasPathClass(info, name))
    }
    const kept = all.filter((finding) => {
        const paths = auditFindingPaths(finding)
        return !paths.length || paths.some((file) => !classified(file))
    })
    return {findings: kept, suppressed: all.length - kept.length}
}

const DEPENDENCY_AUDIT_RULES = new Set(['unused-dep', 'missing-dep', 'duplicate-dep', 'unresolved-import', 'lockfile-drift'])
export const isDependencyAuditFinding = (finding) => DEPENDENCY_AUDIT_RULES.has(String(finding?.rule || ''))

const auditFilter = (audit, args, findings = audit.findings, repoRoot = null) => {
    const minSev = SEVERITY_RANK[args.min_severity] ?? 4
    const category = args.category ? String(args.category) : null
    return auditFindingPathScope(findings, {includeClassified: args.include_classified === true, repoRoot}).findings
        .filter((finding) => (SEVERITY_RANK[finding.severity] ?? 4) <= minSev)
        .filter((finding) => !category || (category === 'dependencies' ? isDependencyAuditFinding(finding) : finding.category === category))
}

const auditChecksLine = (audit) => {
    const check = (name, state) => `${name} ${state?.status || 'ERROR'}${state?.detail ? ` — ${state.detail}` : ''}`
    return `Checks: ${check('OSV', audit.checks?.osv)}; ${check('malware', audit.checks?.malware)}. A NOT_CHECKED/PARTIAL/ERROR check is incomplete or unknown, never a clean zero.`
}

const auditConventionLines = (audit) => {
    const entries = audit.conventionReachability?.entries || []
    if (!entries.length) return []
    return [
        `Convention reachability: ${audit.conventionReachability.count} framework-managed file(s) are external entry points, not orphan/dead findings${audit.conventionReachability.truncated ? ' (evidence capped)' : ''}:`,
        ...entries.slice(0, 5).map((entry) => `  [${entry.confidence}] ${entry.file} — ${entry.marker}: ${entry.reason}`),
        audit.conventionReachability.count > 5 ? `  … +${audit.conventionReachability.count - 5} more in bounded JSON result data` : null,
    ].filter((line) => line != null)
}

const formatOrdinaryAudit = (audit, args, findings = audit.findings, heading = null, repoRoot = null) => {
    const max = Math.max(1, Math.min(100, Number(args.max_findings) || 30))
    const pathScope = auditFindingPathScope(findings, {includeClassified: args.include_classified === true, repoRoot})
    const filtered = auditFilter(audit, args, pathScope.findings, repoRoot)
    const shown = filtered.slice(0, max)
    const summary = summarizeFindings(pathScope.findings)
    const sev = summary.bySeverity
    const bycat = summary.byCategory
    const deps = audit.dependencyReport || {}
    return [
        heading,
        `Internal audit of ${audit.repo} (${audit.scanned.files} files, ${audit.scanned.symbols} symbols, ${audit.scanned.externalImports} external imports; malware scan: ${audit.scanned.malwareScanMode}).`,
        ...auditConventionLines(audit),
        `Dependency manifests: ${deps.status || 'UNKNOWN'} — checked ${deps.declared ?? audit.scanned.manifestDeps ?? 0} declared package(s) against ${deps.importRecords ?? audit.scanned.externalImports ?? 0} external import record(s); unused ${deps.unused ?? 'unknown'}, missing ${deps.missing ?? 'unknown'}, duplicate declarations ${deps.duplicateDeclarations ?? 'unknown'}. npm per-finding manifest/source/config verification: ${deps.perFindingVerification ? 'AVAILABLE' : 'UNAVAILABLE'}.`,
        `Scoped severity: critical ${sev.critical}, high ${sev.high}, medium ${sev.medium}, low ${sev.low}, info ${sev.info}. Scoped categories: unused ${bycat.unused}, structure ${bycat.structure}, vulnerability ${bycat.vulnerability}, malware ${bycat.malware}.`,
        pathScope.suppressed ? `Path policy: production-first; suppressed ${pathScope.suppressed} finding(s) whose evidence is entirely test/e2e/generated/mock/story/docs/benchmark/temp or explicitly excluded. Pass include_classified:true to include them.` : 'Path policy: production-first; no classified-only findings were suppressed.',
        `Repository-level ${auditChecksLine(audit)}`,
        '',
        `Showing ${shown.length} of ${filtered.length} finding(s)${args.category ? ` in category "${args.category}"` : ''}${args.min_severity ? ` at ≥${args.min_severity}` : ''}:`,
        ...shown.map(formatAuditFinding),
        filtered.length > shown.length ? `  … +${filtered.length - shown.length} more (raise max_findings or filter by category/min_severity)` : null,
    ].filter((line) => line != null).join('\n')
}

const gitUntracked = (repoRoot) => {
    const result = spawnSync('git', ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard'], {
        encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024, env: childProcessEnv(), windowsHide: true,
    })
    if (result.status !== 0) return {
        ok: false,
        files: [],
        error: String(result.stderr || result.error?.message || 'git ls-files failed').trim(),
    }
    return {
        ok: true,
        files: String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        error: null,
    }
}

const pathsFromClassification = (classification) => [...new Set(classification.files
    .flatMap((file) => [file.oldPath, file.newPath])
    .filter((file) => file && file !== '(diff unavailable)'))]
    .sort((left, right) => left.localeCompare(right))

const formatDebtFinding = (finding, state) => `  [${state}] ${formatAuditFinding(finding).trimStart()}`

async function runAuditWithBaseline(args, ctx, currentGraph) {
    const resolved = resolveGitCommit(ctx.repoRoot, args.base_ref)
    if (!resolved.ok) return toolResult(`Audit baseline unavailable: ${resolved.error}.`, {
        status: 'INVALID', comparison: {status: 'UNAVAILABLE', reason: resolved.error}, findings: [],
    }, {completeness: {status: 'PARTIAL', reason: resolved.error}})

    let currentAudit
    try {
        currentAudit = await runInternalAudit(ctx.repoRoot, {
            graph: currentGraph,
            skipMalwareScan: !args.include_malware_scan,
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return toolResult(`Audit failed while building the current graph: ${reason}`, {
            status: 'ERROR', comparison: {status: 'UNAVAILABLE', reason}, findings: [],
        }, {completeness: {status: 'PARTIAL', reason}})
    }
    if (!currentAudit.ok) return toolResult(`Audit failed: ${currentAudit.error}`, {
        status: 'ERROR', comparison: {status: 'UNAVAILABLE', reason: currentAudit.error}, findings: [],
    }, {completeness: {status: 'PARTIAL', reason: currentAudit.error}})

    const normalized = normalizeAuditScopeFiles(args.changed_files)
    if (!normalized.ok) return toolResult(`Audit scope invalid: ${normalized.error}.`, {
        status: 'INVALID', comparison: {status: 'UNAVAILABLE', reason: normalized.error}, findings: [],
    }, {completeness: {status: 'PARTIAL', reason: normalized.error}})
    let changedFiles = normalized.files
    let completeChangeSet = false
    let scopeSource = 'explicit changed_files'
    let changeEvidence = null
    if (changedFiles == null) {
        completeChangeSet = true
        const untracked = gitUntracked(ctx.repoRoot)
        if (!untracked.ok) {
            return toolResult(`Audit comparison stopped: untracked-file discovery failed (${untracked.error}). Pass changed_files explicitly to establish the scope.`, {
                status: 'PARTIAL', comparison: {status: 'UNAVAILABLE', reason: untracked.error}, findings: [],
            }, {completeness: {status: 'PARTIAL', reason: untracked.error}})
        }
        changeEvidence = classifyChangeImpact({
            repoRoot: ctx.repoRoot,
            graph: currentGraph,
            base: resolved.commit,
            files: untracked.files,
        })
        if (!changeEvidence.ok || changeEvidence.bounds?.truncated) {
            const reason = changeEvidence.reasons.join(' ')
            return toolResult(`Audit comparison stopped: changed-file derivation against ${resolved.ref} was incomplete. ${reason} Pass changed_files explicitly to establish a complete scope.`, {
                status: 'PARTIAL', comparison: {status: 'UNAVAILABLE', reason}, findings: [], changeEvidence,
            }, {completeness: {status: 'PARTIAL', reason}})
        }
        changedFiles = pathsFromClassification(changeEvidence)
        if (changedFiles.length > 500) {
            const reason = `derived changed-file scope contains ${changedFiles.length} files, above the 500-file comparison bound`
            return toolResult(`Audit comparison stopped: ${reason}. Pass a narrower explicit changed_files scope.`, {
                status: 'PARTIAL', comparison: {status: 'UNAVAILABLE', reason}, findings: [], changeEvidence,
            }, {completeness: {status: 'PARTIAL', reason}})
        }
        scopeSource = `git diff ${resolved.commit.slice(0, 12)}…working-tree`
    }

    const baseline = await withGitRefCheckout(ctx.repoRoot, resolved.commit, async (checkout) => {
        let graph = await buildInternalGraph(checkout)
        const currentMode = ['full', 'no-tests', 'tests-only'].includes(currentGraph?.graphBuildMode)
            ? currentGraph.graphBuildMode : 'full'
        if (currentMode !== 'full') graph = filterGraphForMode(graph, currentMode, {repoRoot: checkout})
        graph.graphBuildMode = currentMode
        graph.graphBuildScope = ''
        return runInternalAudit(checkout, {graph, skipMalwareScan: true})
    })
    if (!baseline.ok || !baseline.value?.ok) {
        const reason = baseline.error || baseline.value?.error || 'baseline audit failed'
        return toolResult(`Audit baseline unavailable: ${reason}.`, {
            status: 'ERROR', comparison: {status: 'UNAVAILABLE', reason}, findings: [],
        }, {completeness: {status: 'PARTIAL', reason}})
    }

    const comparison = compareAuditDebt(currentAudit, baseline.value, changedFiles, {completeChangeSet})
    const mode = ['new', 'existing', 'all'].includes(args.debt) ? args.debt : 'new'
    const selectedRaw = mode === 'new' ? comparison.new : mode === 'existing' ? comparison.existing : comparison.all
    const selected = auditFilter(currentAudit, args, selectedRaw, ctx.repoRoot)
    const max = Math.max(1, Math.min(100, Number(args.max_findings) || 30))
    const shown = selected.slice(0, max)
    const optional = comparison.optional.checks.map((check) => `${check.name.toUpperCase()} UNCOMPARABLE (current ${check.current}; baseline ${check.baseline})`).join('; ')
    const stateOf = (finding) => mode === 'all' ? finding.debtState : mode
    const fixedShown = auditFilter(baseline.value, args, comparison.fixed, ctx.repoRoot).slice(0, Math.min(10, max))
    const text = [
        `${mode.toUpperCase()} DEBT — deterministic internal audit vs ${resolved.ref} (${resolved.commit.slice(0, 12)})`,
        `Changed scope: ${changedFiles.length} file(s) from ${scopeSource}${changedFiles.length ? ` — ${changedFiles.slice(0, 12).join(', ')}${changedFiles.length > 12 ? ', …' : ''}` : ' — working tree matches the baseline'}.`,
        `Scope comparison: ${comparison.totals.scope.new} new, ${comparison.totals.scope.existing} existing, ${comparison.totals.scope.fixed} fixed deterministic finding(s). Repository totals: ${comparison.totals.repository.new} new, ${comparison.totals.repository.existing} existing, ${comparison.totals.repository.fixed} fixed.`,
        `Optional checks: ${optional}. Supply-chain findings are not assigned new/existing/fixed state from a source-only checkout.`,
        '',
        `Showing ${shown.length} of ${selected.length} ${mode} finding(s) after filters:`,
        ...shown.map((finding) => formatDebtFinding(finding, stateOf(finding))),
        selected.length > shown.length ? `  … +${selected.length - shown.length} more` : null,
        '',
        `Fixed in this changed scope: ${comparison.fixed.length}${fixedShown.length ? ' (sample below)' : ''}.`,
        ...fixedShown.map((finding) => formatDebtFinding(finding, 'fixed')),
    ].filter((line) => line != null).join('\n')
    return toolResult(text, {
        status: 'COMPLETE',
        mode: 'baseline-comparison',
        debt: mode,
        baseline: {ref: resolved.ref, commit: resolved.commit},
        scope: {files: changedFiles, source: scopeSource},
        comparison: {
            status: 'COMPLETE',
            scope: comparison.scope,
            totals: comparison.totals,
            new: comparison.new,
            existing: comparison.existing,
            fixed: comparison.fixed,
            optional: comparison.optional,
        },
        findings: selected,
        changeEvidence,
    }, {
        page: {shown: shown.length, total: selected.length, capped: shown.length < selected.length},
        completeness: {status: 'COMPLETE'},
    })
}

// Full internal health audit: dead code + unused exports, dependency findings (npm/go/py missing &
// unused deps), structure (import cycles / orphans / boundary rules), supply-chain (offline OSV
// advisories, typosquat, lockfile drift), optional malware heuristics.
export async function tRunAudit(g, args, ctx) {
    if (!ctx.repoRoot) return 'Audit needs the repo root (not provided to this server).'
    if (args.base_ref) return runAuditWithBaseline(args, ctx, rawGraph(ctx))
    const audit = await runInternalAudit(ctx.repoRoot, {
        graph: effectiveRawGraph(ctx),
        skipMalwareScan: !args.include_malware_scan, // greps installed packages — slow, so opt-in
    })
    if (!audit.ok) return `Audit failed: ${audit.error}`
    if (Array.isArray(args.changed_files)) {
        const normalized = normalizeAuditScopeFiles(args.changed_files)
        if (!normalized.ok) return `Changed-scope audit invalid: ${normalized.error}.`
        const scoped = scopeAuditFindings(audit.findings, normalized.files)
        const text = formatOrdinaryAudit(audit, args, scoped,
            `CHANGED-SCOPE ONLY — ${normalized.files.length} explicitly supplied file(s); no baseline was provided, so these findings are not classified as new, existing, or fixed.`, ctx.repoRoot)
        return toolResult(text, {
            status: 'COMPLETE',
            mode: 'changed-scope',
            scope: {files: normalized.files, source: 'explicit changed_files'},
            comparison: {status: 'UNAVAILABLE', reason: 'base_ref was not provided; changed-scope is not a new-debt claim'},
            findings: auditFilter(audit, args, scoped, ctx.repoRoot),
        }, {completeness: {status: 'COMPLETE'}})
    }
    return formatOrdinaryAudit(audit, args, audit.findings, null, ctx.repoRoot)
}

// Named module clusters: graph communities labeled by their dominant folder instead of bare numbers.
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
export function tListEndpoints(g, args, ctx) {
    if (!ctx.repoRoot) return 'Endpoint detection needs the repo root (not provided to this server).'
    const graph = rawGraph(ctx)
    const codeFiles = [...new Set(
        (graph.nodes || [])
            .filter((n) => !String(n.id).includes('#') && n.source_file && n.file_type === 'code')
            .map((n) => n.source_file)
    )]
    const inventory = analyzeEndpointInventory(ctx.repoRoot, codeFiles)
    let eps = inventory.endpoints
    const method = args.method ? String(args.method).toUpperCase() : null
    const path = args.path ? String(args.path) : null
    if (method) eps = eps.filter((endpoint) => endpoint.method === method)
    if (path) eps = eps.filter((endpoint) => endpoint.path === path || endpoint.path.endsWith(path))
    if (!eps.length) return 'No HTTP endpoints detected in the indexed code files.'
    const max = Math.max(1, Math.min(300, Number(args.max_results) || 100))
    const shown = eps.slice(0, max)
    const stats = inventory.stats
    const text = [
        `${eps.length} endpoint(s) matched${eps.length > shown.length ? `, showing ${shown.length}` : ''}. Inventory: ${stats.declaredRoutes} declaration(s); ${stats.reachableStaticRoutes} statically reachable composed route(s); ${stats.localDeclarations} local/root declaration candidate(s); ${stats.staticMounts} static router mount(s)${stats.truncated ? `; TRUNCATED at ${stats.maxEndpoints}` : ''}.`,
        ...shown.map((e) => {
            const via = e.mountChain?.length
                ? `\n           declared ${e.declaredPath} in ${e.file}${e.line ? `:${e.line}` : ''}; mount chain ${e.mountChain.map((mount) => `${mount.file}:${mount.line} ${mount.path}`).join(' → ')}`
                : ''
            return `  ${e.method.toUpperCase().padEnd(6)} ${e.path}${e.handler ? `  → ${e.handler}` : ''}  (${e.file}${e.line ? `:${e.line}` : ''}; ${e.mountState}/${e.confidence})${via}`
        }),
    ].join('\n')
    return toolResult(text, {
        filters: {method, path},
        stats,
        endpoints: shown,
        page: {shown: shown.length, total: eps.length, truncated: eps.length > shown.length || stats.truncated},
    }, {completeness: {status: stats.truncated ? 'PARTIAL' : 'COMPLETE', reason: stats.truncated ? `endpoint cap ${stats.maxEndpoints} reached` : 'all indexed code files scanned'}})
}
