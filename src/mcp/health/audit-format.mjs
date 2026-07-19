import {spawnSync} from 'node:child_process'
import {summarizeFindings} from '../../analysis/findings.js'
import {childProcessEnv} from '../../child-env.js'
import {createPathClassifier, hasPathClass} from '../../path-classification.js'

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

export const auditFilter = (audit, args, findings = audit.findings, repoRoot = null) => {
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

const auditCapabilityLines = (audit) => {
    const matrix = audit.healthCapabilities || {}
    const rows = [
        ['structure', 'structure'],
        ['dependencies', 'dependencies'],
        ['runtimeCorrectness', 'runtime correctness'],
        ['concurrency', 'concurrency'],
        ['advisories', 'advisories'],
        ['malware', 'malware'],
        ['coverage', 'coverage'],
    ]
    const lines = ['Health capability matrix (status/completeness):']
    for (const [key, label] of rows) {
        const item = matrix[key]
        lines.push(`  ${label}: ${item?.status || 'NOT_CHECKED'}/${item?.completeness || 'PARTIAL'} — ${item?.detail || 'Capability evidence was not reported.'}`)
    }
    return lines
}

const auditDependencyCoverageLines = (deps) => {
    const ecosystems = Object.values(deps.ecosystems || {}).filter((item) => item?.present)
    const verification = Object.entries(deps.verificationCoverage || {})
    return [
        ecosystems.length
            ? `Dependency ecosystems: ${ecosystems.map((item) => `${item.ecosystem} ${item.status}/${item.completeness} (${item.manifests?.length || 0} manifest(s), ${item.declared || 0} declaration(s))`).join('; ')}.`
            : 'Dependency ecosystems: no supported or unsupported dependency manifest was discovered.',
        verification.length
            ? `Dependency verification coverage: ${verification.map(([ecosystem, state]) => `${ecosystem} ${state}`).join('; ')}. Per-finding evidence: ${deps.perFindingVerification ? 'AVAILABLE' : 'UNAVAILABLE'}.`
            : 'Dependency verification coverage: NOT_CHECKED; no manifest evidence was available.',
    ]
}

const auditDependencySummaryLine = (audit, deps) => {
    const ecosystems = Object.values(deps.ecosystems || {}).filter((item) => item?.present)
    const checked = ecosystems.filter((item) => item.status === 'CHECKED')
    const unsupported = ecosystems.filter((item) => item.status === 'NOT_SUPPORTED')
    if (!ecosystems.length || deps.status === 'NOT_CHECKED') {
        return 'Dependency manifests: NOT_CHECKED — no dependency manifest was discovered; manifest-to-import verification did not run and no dependency verdict was produced.'
    }
    if (!checked.length && unsupported.length) {
        const manifests = unsupported.reduce((total, item) => total + (item.manifests?.length || 0), 0)
        const declared = unsupported.reduce((total, item) => total + (item.declared || 0), 0)
        const names = unsupported.map((item) => item.ecosystem).join(', ')
        return `Dependency manifests: ${deps.status || 'PARTIAL'} — discovered ${declared} declaration(s) in ${manifests} ${names} manifest(s), but package-to-artifact verification is NOT_SUPPORTED; no unused, missing, or duplicate-declaration verdict was produced for those ecosystems.`
    }
    if (checked.length && unsupported.length) {
        const checkedManifests = checked.reduce((total, item) => total + (item.manifests?.length || 0), 0)
        const checkedDeclared = checked.reduce((total, item) => total + (item.declared || 0), 0)
        const unsupportedManifests = unsupported.reduce((total, item) => total + (item.manifests?.length || 0), 0)
        const unsupportedDeclared = unsupported.reduce((total, item) => total + (item.declared || 0), 0)
        const checkedNames = checked.map((item) => item.ecosystem).join(', ')
        const unsupportedNames = unsupported.map((item) => item.ecosystem).join(', ')
        return `Dependency manifests: ${deps.status || 'PARTIAL'} — checked ${checkedDeclared} declaration(s) across ${checkedManifests} supported manifest(s) (${checkedNames}); inventoried ${unsupportedDeclared} declaration(s) across ${unsupportedManifests} unsupported manifest(s) (${unsupportedNames}), where package-to-artifact verification is NOT_SUPPORTED. Supported-ecosystem findings: unused ${deps.unused ?? 'unknown'}, missing ${deps.missing ?? 'unknown'}, duplicate declarations ${deps.duplicateDeclarations ?? 'unknown'}.`
    }
    return `Dependency manifests: ${deps.status || 'UNKNOWN'} — checked ${deps.declared ?? audit.scanned.manifestDeps ?? 0} declared package(s) against ${deps.importRecords ?? audit.scanned.externalImports ?? 0} external import record(s); unused ${deps.unused ?? 'unknown'}, missing ${deps.missing ?? 'unknown'}, duplicate declarations ${deps.duplicateDeclarations ?? 'unknown'}.`
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

export const formatOrdinaryAudit = (audit, args, findings = audit.findings, heading = null, repoRoot = null) => {
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
        auditDependencySummaryLine(audit, deps),
        ...auditDependencyCoverageLines(deps),
        ...auditCapabilityLines(audit),
        `Scoped severity: critical ${sev.critical}, high ${sev.high}, medium ${sev.medium}, low ${sev.low}, info ${sev.info}. Scoped categories: unused ${bycat.unused}, structure ${bycat.structure}, vulnerability ${bycat.vulnerability}, malware ${bycat.malware}.`,
        pathScope.suppressed ? `Path policy: production-first; suppressed ${pathScope.suppressed} finding(s) whose evidence is entirely test/e2e/generated/mock/story/docs/benchmark/temp or explicitly excluded. Pass include_classified:true to include them.` : 'Path policy: production-first; no classified-only findings were suppressed.',
        `Repository-level ${auditChecksLine(audit)}`,
        '',
        `Showing ${shown.length} of ${filtered.length} finding(s)${args.category ? ` in category "${args.category}"` : ''}${args.min_severity ? ` at ≥${args.min_severity}` : ''}:`,
        ...shown.map(formatAuditFinding),
        filtered.length > shown.length ? `  … +${filtered.length - shown.length} more (raise max_findings or filter by category/min_severity)` : null,
    ].filter((line) => line != null).join('\n')
}

export const gitUntracked = (repoRoot) => {
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

export const pathsFromClassification = (classification) => [...new Set(classification.files
    .flatMap((file) => [file.oldPath, file.newPath])
    .filter((file) => file && file !== '(diff unavailable)'))]
    .sort((left, right) => left.localeCompare(right))

export const formatDebtFinding = (finding, state) => `  [${state}] ${formatAuditFinding(finding).trimStart()}`
