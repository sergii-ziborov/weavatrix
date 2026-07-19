import {
    CAPS, COMPLEXITY_THRESHOLDS, STATE, VERDICT, addIf, bounded, compareText, graphId,
    normalizeCheckState, numericRecord, optionalNonNegativeInteger, privacySafeText, repoRelativePath,
    sanitizeFinding,
} from './evidence-snapshot.common.mjs'
import {summarizeFindings} from '../analysis/findings.js'
import {auditFindingPathScope} from './health/audit-format.mjs'

function buildHotspots(graph) {
    let analyzed = 0
    const facts = []
    for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
        if (!node || typeof node !== 'object' || !node.complexity || typeof node.complexity !== 'object') continue
        const id = graphId(node.id)
        const file = repoRelativePath(node.source_file)
        if (!id || !file) continue
        analyzed++
        const loc = optionalNonNegativeInteger(node.complexity.loc)
        const cyclomatic = optionalNonNegativeInteger(node.complexity.cyclomatic)
        const params = optionalNonNegativeInteger(node.complexity.params)
        const breaches = []
        let severity = 'medium'
        if (loc !== undefined && loc >= COMPLEXITY_THRESHOLDS.loc.high) { breaches.push('LOC_HIGH'); severity = 'high' }
        else if (loc !== undefined && loc >= COMPLEXITY_THRESHOLDS.loc.warning) breaches.push('LOC_WARNING')
        if (cyclomatic !== undefined && cyclomatic >= COMPLEXITY_THRESHOLDS.cyclomatic.high) { breaches.push('CYCLOMATIC_HIGH'); severity = 'high' }
        else if (cyclomatic !== undefined && cyclomatic >= COMPLEXITY_THRESHOLDS.cyclomatic.warning) breaches.push('CYCLOMATIC_WARNING')
        if (params !== undefined && params >= COMPLEXITY_THRESHOLDS.params.high) { breaches.push('PARAMS_HIGH'); severity = 'high' }
        else if (params !== undefined && params >= COMPLEXITY_THRESHOLDS.params.warning) breaches.push('PARAMS_WARNING')
        if (!breaches.length) continue
        const fact = {id, file, severity, breaches: breaches.sort(compareText)}
        addIf(fact, 'symbol', privacySafeText(node.label, 256))
        addIf(fact, 'startLine', optionalNonNegativeInteger(node.complexity.startLine))
        addIf(fact, 'endLine', optionalNonNegativeInteger(node.complexity.endLine))
        addIf(fact, 'loc', loc)
        addIf(fact, 'cyclomatic', cyclomatic)
        addIf(fact, 'params', params)
        facts.push(fact)
    }
    facts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) ||
        (b.loc || 0) - (a.loc || 0) || (b.cyclomatic || 0) - (a.cyclomatic || 0) ||
        (b.params || 0) - (a.params || 0) || compareText(a.id, b.id))
    return {analyzed, ...bounded(facts, CAPS.hotspots)}
}

export function buildHealthSection(graph, audit, repoRoot = null) {
    if (!audit?.ok) {
        return {
            state: STATE.ERROR,
            verdict: VERDICT.UNKNOWN,
            completeness: {reasons: ['AUDIT_ERROR']},
            summary: {bySeverity: {}, byCategory: {}},
            checks: {osv: STATE.ERROR, malware: STATE.ERROR},
            findings: [],
            complexity: {thresholds: COMPLEXITY_THRESHOLDS, analyzed: 0, hotspots: []},
        }
    }
    // Public/private hosted evidence follows the same production-first path policy as
    // run_audit. Classified-only findings remain available locally through
    // include_classified:true, but must not turn a hosted production snapshot red.
    const scopedFindings = auditFindingPathScope(audit.findings, {repoRoot}).findings
    const scopedSummary = summarizeFindings(scopedFindings)
    const findings = bounded(scopedFindings.map(sanitizeFinding).filter(Boolean)
        .sort((a, b) => compareText(a.severity, b.severity) || compareText(a.category, b.category) ||
            compareText(a.rule, b.rule) || compareText(a.file || a.package || '', b.file || b.package || '') || compareText(a.id, b.id)),
    CAPS.findings)
    const hotspots = buildHotspots(graph)
    const checks = {
        osv: normalizeCheckState(audit.checks?.osv?.status),
        malware: normalizeCheckState(audit.checks?.malware?.status),
    }
    const state = Object.values(checks).every((value) => value === STATE.COMPLETE || value === STATE.NOT_APPLICABLE)
        ? STATE.COMPLETE
        : STATE.PARTIAL
    return {
        state,
        verdict: findings.completeness.total > 0 || hotspots.completeness.total > 0
            ? VERDICT.FAIL
            : state === STATE.COMPLETE ? VERDICT.PASS : VERDICT.UNKNOWN,
        completeness: {
            findings: findings.completeness,
            hotspots: hotspots.completeness,
            complexity: {analyzed: hotspots.analyzed},
            reasons: state === STATE.PARTIAL ? ['OPTIONAL_CHECKS_INCOMPLETE'] : [],
        },
        summary: {
            bySeverity: numericRecord(scopedSummary.bySeverity, ['critical', 'high', 'medium', 'low', 'info']),
            byCategory: numericRecord(scopedSummary.byCategory, ['unused', 'structure', 'vulnerability', 'malware']),
            dead: numericRecord(audit.deadReport, ['deadSymbols', 'deadFiles', 'unusedExports']),
            structure: numericRecord(audit.structureReport, [
                'runtimeImportEdges', 'typeOnlyImportEdges', 'compileOnlyImportEdges', 'runtimeCycles',
                'compileTimeCouplings', 'largestCycle', 'largestCompileTimeCoupling', 'orphans', 'boundaryViolations',
            ]),
        },
        checks,
        findings: findings.items,
        complexity: {
            thresholds: COMPLEXITY_THRESHOLDS,
            analyzed: hotspots.analyzed,
            hotspots: hotspots.items,
        },
    }
}
