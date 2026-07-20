import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runInternalAudit} from '../src/analysis/internal-audit.js'
import {tFindDeadCode} from '../src/mcp/tools-health.mjs'

test('unused export evidence and the dead-code queue share public-surface confidence', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'weavatrix-audit-dead-consistency-'))
  const file = 'src/product.ts'
  const symbol = `${file}#uniqueProductSignal@1`
  const graph = {
    nodes: [
      {id: file, source_file: file, file_type: 'code'},
      {id: symbol, label: 'uniqueProductSignal()', source_file: file, source_location: 'L1', exported: true},
    ],
    links: [{source: file, target: symbol, relation: 'contains'}],
    externalImports: [],
  }
  try {
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'fixture'}))
    writeFileSync(join(repo, file), 'export function uniqueProductSignal() { return 1; }\n')
    const graphPath = join(repo, 'graph.json')
    writeFileSync(graphPath, JSON.stringify(graph))

    const audit = await runInternalAudit(repo, {
      graph,
      advisoryStorePath: join(repo, 'missing-advisories.json'),
      skipMalwareScan: true,
    })
    const unusedExport = audit.findings.find((finding) => finding.rule === 'unused-export')
    assert.ok(unusedExport)
    assert.equal(unusedExport.severity, 'info')
    assert.equal(unusedExport.confidence, 'low')
    assert.equal(unusedExport.classification, 'unused-export-surface')
    assert.equal(unusedExport.deadCodeCandidate, false)
    assert.match(unusedExport.detail, /not proof that the implementation is dead/i)

    const deadReview = tFindDeadCode(null, {}, {repoRoot: repo, graphPath})
    assert.equal(deadReview.result.candidates.length, 0)
    assert.ok(deadReview.result.suppressed.confidence > 0)
    assert.match(deadReview.text, /min_confidence=low/)
  } finally {
    rmSync(repo, {recursive: true, force: true})
  }
})
