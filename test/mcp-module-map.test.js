import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {loadGraph} from '../src/mcp/graph-context.mjs'
import {tModuleMap} from '../src/mcp/tools-health.mjs'

function graphFile(graph) {
  const dir = mkdtempSync(join(tmpdir(), 'weavatrix-signal-'))
  const path = join(dir, 'graph.json')
  writeFileSync(path, JSON.stringify(graph))
  return {dir, path, graph: loadGraph(path)}
}

test('module_map excludes classified non-product surfaces unless explicitly requested', () => {
  const fixture = graphFile({
    edgeTypesV: 2,
    nodes: [
      {id: 'src/app.js', source_file: 'src/app.js', file_type: 'code'},
      {id: 'test/app.test.js', source_file: 'test/app.test.js', file_type: 'code'},
      {id: 'benchmarks/fixtures/case.js', source_file: 'benchmarks/fixtures/case.js', file_type: 'code'},
    ],
    links: [],
  })
  try {
    const production = tModuleMap(fixture.graph, {top_n: 10}, {graphPath: fixture.path})
    assert.match(production, /Scope: production-only \(default\); excluded 2/)
    assert.match(production, /src .* 1 files/)
    assert.doesNotMatch(production, /test .* 1 files|benchmarks .* 1 files/)
    const complete = tModuleMap(fixture.graph, {top_n: 10, include_non_product: true}, {graphPath: fixture.path})
    assert.match(complete, /Scope: all indexed files/)
    assert.match(complete, /test .* 1 files/)
    assert.match(complete, /benchmarks\/fixtures .* 1 files/)
  } finally { rmSync(fixture.dir, {recursive: true, force: true}) }
})

test('module_map retains classified files automatically for a tests-only graph', () => {
  const fixture = graphFile({
    graphBuildMode: 'tests-only',
    edgeTypesV: 2,
    nodes: [
      {id: 'test/app.test.js', source_file: 'test/app.test.js', file_type: 'code'},
      {id: 'test/helpers/mock.js', source_file: 'test/helpers/mock.js', file_type: 'code'},
    ],
    links: [{source: 'test/app.test.js', target: 'test/helpers/mock.js', relation: 'imports'}],
  })
  try {
    const output = tModuleMap(fixture.graph, {top_n: 10}, {graphPath: fixture.path})
    assert.match(output, /Scope: tests-only graph/)
    assert.match(output, /test .* 1 files/)
    assert.match(output, /test\/helpers .* 1 files/)
    assert.doesNotMatch(output, /production-only/)
  } finally { rmSync(fixture.dir, {recursive: true, force: true}) }
})
