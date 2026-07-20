import test from 'node:test'
import assert from 'node:assert/strict'
import {isDependencyAuditFinding} from '../src/mcp/tools-health.mjs'
import {formatOrdinaryAudit} from '../src/mcp/health/audit-format.mjs'

test('dependencies audit projection selects manifest/import health without relabelling findings', () => {
    for (const rule of ['unused-dep', 'missing-dep', 'duplicate-dep', 'unresolved-import', 'lockfile-drift']) {
        assert.equal(isDependencyAuditFinding({category: rule === 'missing-dep' ? 'structure' : 'unused', rule}), true, rule)
    }
    for (const rule of ['unused-file', 'circular-dep', 'known-vuln', 'malicious-package']) {
        assert.equal(isDependencyAuditFinding({category: 'structure', rule}), false, rule)
    }
})

test('dependency headline follows production-first path scope and reports classified suppression', () => {
    const finding = {
        category: 'unused', rule: 'unused-dep', severity: 'low', confidence: 'medium',
        title: 'Unused dependency: fixture-only', file: 'benchmark/fixtures/demo/package.json',
        package: 'fixture-only',
    }
    const audit = {
        repo: 'fixture',
        scanned: {files: 2, symbols: 0, externalImports: 1, manifestDeps: 2, malwareScanMode: 'skipped'},
        findings: [finding],
        dependencyReport: {
            status: 'COMPLETE', declared: 2, importRecords: 1, unused: 1, missing: 0, duplicateDeclarations: 0,
            ecosystems: {npm: {present: true, ecosystem: 'npm', status: 'CHECKED', completeness: 'COMPLETE', manifests: ['package.json'], declared: 2}},
            verificationCoverage: {npm: 'COMPLETE'}, perFindingVerification: true,
        },
        checks: {},
    }

    const production = formatOrdinaryAudit(audit, {})
    assert.match(production, /unused 0, missing 0, duplicate declarations 0/)
    assert.match(production, /suppressed 1 classified dependency finding/)

    const classified = formatOrdinaryAudit(audit, {include_classified: true})
    assert.match(classified, /unused 1, missing 0, duplicate declarations 0/)
    assert.doesNotMatch(classified, /classified dependency finding/)
})
