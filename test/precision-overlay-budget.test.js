import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildLspPrecisionOverlay} from '../src/precision/lsp-overlay.js'
import {
  fileNode,
  symbolNode,
  withSnapshot,
} from './helpers/precision-overlay-fixtures.js'

test('explicit expanded prewarm queries more than 64 targets while defaults stay bounded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weavatrix-precision-expanded-prewarm-'))
  mkdirSync(join(root, 'src'), {recursive: true})
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({include: ['src/**/*.ts']}))
  const file = 'src/targets.ts'
  const symbols = Array.from({length: 80}, (_, index) => (
    symbolNode(file, `target${index}`, index + 1, index + 1, {visibility: 'private'})
  ))
  writeFileSync(
    join(root, file),
    `${symbols.map((_, index) => `function target${index}() {}`).join('\n')}\n`,
  )
  const graph = withSnapshot(root, {
    graphRevision: 'revision-expanded-prewarm',
    graphBuildMode: 'full',
    nodes: [fileNode(file), ...symbols],
    links: symbols.map((symbol) => ({
      source: file,
      target: symbol.id,
      relation: 'contains',
      provenance: 'EXTRACTED',
    })),
  })
  const clientFactory = async () => ({
    async openDocument() {},
    async references() { return [] },
    async close() {},
  })
  try {
    const bounded = await buildLspPrecisionOverlay({repoRoot: root, graph, clientFactory})
    assert.equal(bounded.request.maxSymbols, 32)
    assert.equal(bounded.coverage.candidates, 80)
    assert.equal(bounded.coverage.selected, 32)
    assert.equal(bounded.coverage.queried, 32)
    assert.equal(bounded.state, 'PARTIAL')

    const expanded = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      maxSymbols: 1_000,
      clientFactory,
    })
    assert.equal(expanded.request.maxSymbols, 1_000)
    assert.equal(expanded.request.maxReferences, 16_000)
    assert.equal(expanded.request.maxLinks, 16_000)
    assert.equal(expanded.coverage.candidates, 80)
    assert.equal(expanded.coverage.selected, 80)
    assert.equal(expanded.coverage.queried, 80)
    assert.equal(expanded.coverage.truncated, false)
    assert.equal(expanded.state, 'COMPLETE')

    const full = await buildLspPrecisionOverlay({
      repoRoot: root,
      graph,
      prewarmMode: 'full',
      maxSymbols: 32,
      clientFactory,
    })
    assert.equal(full.request.maxSymbols, 10_000)
    assert.equal(full.coverage.selected, 80)
    assert.equal(full.coverage.queried, 80)
    assert.equal(full.state, 'COMPLETE')
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})
