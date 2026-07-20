import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildInternalGraph} from '../src/graph/internal-builder.js'

test('internal-builder: bounded new URL dynamic imports keep only static local candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weavatrix-dynamic-import-'))
  try {
    mkdirSync(join(dir, 'src'), {recursive: true})
    writeFileSync(join(dir, 'src', 'tools-health.mjs'), 'export const health = true;\n')
    writeFileSync(join(dir, 'src', 'tools-graph.mjs'), 'export const graph = true;\n')
    writeFileSync(join(dir, 'src', 'catalog.mjs'), [
      "const v = '?v=1';",
      "const name = './tools-graph';",
      "const otherBase = new URL('https://example.test/');",
      'export async function load() {',
      '  await import(new URL(`./tools-health.mjs${v}`, import.meta.url).href);',
      '  await import(new URL(`${name}.mjs`, import.meta.url).href);',
      '  await import(new URL(`https://example.test/tool.mjs${v}`, import.meta.url).href);',
      '  await import(new URL(`./tools-graph.mjs${v}`, otherBase).href);',
      '}',
    ].join('\n'))

    const graph = await buildInternalGraph(dir)
    const dynamic = graph.externalImports.filter((item) => item.file === 'src/catalog.mjs' && item.dynamic)
    assert.equal(dynamic.length, 4)
    assert.deepEqual(dynamic.filter((item) => item.target).map((item) => ({spec: item.spec, target: item.target})), [
      {spec: './tools-health.mjs', target: 'src/tools-health.mjs'},
    ])
    assert.equal(dynamic.filter((item) => !item.target).length, 3,
      'runtime paths, remote URLs, and non-module bases stay UNKNOWN')
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})
