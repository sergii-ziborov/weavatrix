import {rawGraph, effectiveRawGraph} from '../graph-context.mjs'
import {runInternalAudit} from '../../analysis/internal-audit.js'
import {applyAuditExtensions} from '../../analysis/audit-extensions.js'
import {classifyChangeImpact} from '../../analysis/change-classification.js'
import {
  compareAuditDebt,
  normalizeAuditScopeFiles,
  scopeAuditFindings,
} from '../../analysis/audit-debt.js'
import {buildInternalGraph} from '../../graph/internal-builder.js'
import {resolveGitCommit, withGitRefCheckout} from '../../analysis/git-ref-graph.js'
import {filterGraphForMode} from '../../graph/graph-filter.js'
import {toolResult} from '../tool-result.mjs'
const auditFormatVersion = new URL(import.meta.url).search
const {
  auditFilter,
  formatDebtFinding,
  formatOrdinaryAudit,
  gitUntracked,
  pathsFromClassification,
} = await import(new URL(`./audit-format.mjs${auditFormatVersion}`, import.meta.url).href)

const runAudit = async (repoRoot, graph, args, ctx, options = {}) => applyAuditExtensions(
    await runInternalAudit(repoRoot, {graph, ...options}),
    {providers: ctx.extensions?.auditProviders || [], repoRoot, graph, args},
)

async function runAuditWithBaseline(args, ctx, currentGraph) {
    const resolved = resolveGitCommit(ctx.repoRoot, args.base_ref)
    if (!resolved.ok) return toolResult(`Audit baseline unavailable: ${resolved.error}.`, {
        status: 'INVALID', comparison: {status: 'UNAVAILABLE', reason: resolved.error}, findings: [],
    }, {completeness: {status: 'PARTIAL', reason: resolved.error}})

    let currentAudit
    try {
        currentAudit = await runAudit(ctx.repoRoot, currentGraph, args, ctx, {skipMalwareScan: !args.include_malware_scan})
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
        return runAudit(checkout, graph, args, ctx, {skipMalwareScan: true})
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
    const graph = effectiveRawGraph(ctx)
    const audit = await runAudit(ctx.repoRoot, graph, args, ctx, {
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
