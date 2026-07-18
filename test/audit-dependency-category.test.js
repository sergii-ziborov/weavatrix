import test from 'node:test'
import assert from 'node:assert/strict'
import {isDependencyAuditFinding} from '../src/mcp/tools-health.mjs'

test('dependencies audit projection selects manifest/import health without relabelling findings', () => {
    for (const rule of ['unused-dep', 'missing-dep', 'duplicate-dep', 'unresolved-import', 'lockfile-drift']) {
        assert.equal(isDependencyAuditFinding({category: rule === 'missing-dep' ? 'structure' : 'unused', rule}), true, rule)
    }
    for (const rule of ['unused-file', 'circular-dep', 'known-vuln', 'malicious-package']) {
        assert.equal(isDependencyAuditFinding({category: 'structure', rule}), false, rule)
    }
})
