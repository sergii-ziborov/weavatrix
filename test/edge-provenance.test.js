import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildInternalGraph} from '../src/graph/internal-builder.js'
import {
  EDGE_PROVENANCE_KINDS,
  EDGE_PROVENANCE_V,
  edgeProvenance,
  summarizeEdgeProvenance,
} from '../src/graph/edge-provenance.js'

test('edge provenance: explicit origin wins and legacy graphs degrade safely', () => {
  assert.deepEqual(EDGE_PROVENANCE_KINDS, ['EXACT_LSP', 'EXTRACTED', 'RESOLVED', 'INFERRED', 'CONFLICT'])
  assert.equal(edgeProvenance({provenance: 'exact_lsp', confidence: 'INFERRED'}), 'EXACT_LSP')
  assert.equal(edgeProvenance({semanticOrigin: true, confidence: 'EXTRACTED'}), 'RESOLVED')
  assert.equal(edgeProvenance({confidence: 'INFERRED'}), 'INFERRED')
  assert.equal(edgeProvenance({provenance: 'private-value'}), 'UNKNOWN')
})

test('edge provenance: builder classifies every edge and distinguishes extraction, resolution and inference', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'weavatrix-provenance-'))
  try {
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'src', 'value.ts'), 'export function value(){ return 1; }\n')
    writeFileSync(join(repo, 'src', 'use.ts'), "import { value } from './value';\nexport function use(){ return value(); }\n")
    const graph = await buildInternalGraph(repo)
    const provenance = summarizeEdgeProvenance(graph.links)
    assert.equal(graph.edgeProvenanceV, EDGE_PROVENANCE_V)
    assert.equal(provenance.complete, true)
    assert.ok(graph.links.some((link) => link.relation === 'contains' && link.provenance === 'EXTRACTED'))
    assert.ok(graph.links.some((link) => link.relation === 'imports' && link.provenance === 'RESOLVED'))
    assert.ok(graph.links.some((link) => link.relation === 'calls' && link.provenance === 'INFERRED'))
  } finally { rmSync(repo, {recursive: true, force: true}) }
})
