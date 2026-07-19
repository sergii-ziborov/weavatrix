import assert from 'node:assert/strict'
import test from 'node:test'
import {applyAuditExtensions} from '../src/analysis/audit-extensions.js'

const coreAudit = () => ({
  ok: true,
  findings: [],
  summary: {},
})

test('local extension analyzers augment core findings without replacing the core audit', async () => {
  const audit = await applyAuditExtensions(coreAudit(), {
    repoRoot: 'C:/repo', graph: {nodes: [], links: []},
    providers: [{
      id: 'policy', extension: 'example', network: 'none',
      run: async () => ({
        status: 'CHECKED', completeness: 'COMPLETE', detail: 'policy checked',
        findings: [{category: 'structure', rule: 'extension-policy', severity: 'low', confidence: 'high', title: 'Extension policy finding'}],
      }),
    }],
  })
  assert.equal(audit.findings.length, 1)
  assert.equal(audit.findings[0].source, 'extension:example')
  assert.deepEqual(audit.extensionCapabilities, [{
    id: 'policy', extension: 'example', status: 'CHECKED', completeness: 'COMPLETE',
    detail: 'policy checked', evidence: null, findingCount: 1,
  }])
})

test('extension analyzer failure remains ERROR/PARTIAL and cannot look clean', async () => {
  const audit = await applyAuditExtensions(coreAudit(), {
    providers: [{id: 'broken', extension: 'example', run: async () => { throw new Error('provider unavailable') }}],
  })
  assert.equal(audit.findings.length, 0)
  assert.equal(audit.extensionCapabilities[0].status, 'ERROR')
  assert.equal(audit.extensionCapabilities[0].completeness, 'PARTIAL')
  assert.match(audit.extensionCapabilities[0].detail, /unavailable/)
})
