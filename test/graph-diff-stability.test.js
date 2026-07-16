import test from 'node:test'
import assert from 'node:assert/strict'
import {diffGraphs} from '../src/mcp/graph-diff.mjs'

const metadata = {edgeTypesV: 2, barrelResolutionV: 1, extractorSchemaV: 1}

test('graph diff treats symbol line shifts as stable identity', () => {
  const oldGraph = {
    ...metadata,
    nodes: [
      {id: 'src/a.js', source_file: 'src/a.js'},
      {id: 'src/a.js#first@10', label: 'first()', source_file: 'src/a.js', source_location: 'L10', symbol_kind: 'function', exported: true, complexity: {params: 1}},
      {id: 'src/a.js#second@20', label: 'second()', source_file: 'src/a.js', source_location: 'L20', symbol_kind: 'function', complexity: {params: 0}},
    ],
    links: [
      {source: 'src/a.js', target: 'src/a.js#first@10', relation: 'contains'},
      {source: 'src/a.js', target: 'src/a.js#second@20', relation: 'contains'},
      {source: 'src/a.js#first@10', target: 'src/a.js#second@20', relation: 'calls'},
    ],
  }
  const newGraph = {
    ...metadata,
    nodes: [
      {id: 'src/a.js', source_file: 'src/a.js'},
      {id: 'src/a.js#first@14', label: 'first()', source_file: 'src/a.js', source_location: 'L14', symbol_kind: 'function', exported: true, complexity: {params: 1}},
      {id: 'src/a.js#second@24', label: 'second()', source_file: 'src/a.js', source_location: 'L24', symbol_kind: 'function', complexity: {params: 0}},
    ],
    links: [
      {source: 'src/a.js', target: 'src/a.js#first@14', relation: 'contains'},
      {source: 'src/a.js', target: 'src/a.js#second@24', relation: 'contains'},
      {source: 'src/a.js#first@14', target: 'src/a.js#second@24', relation: 'calls'},
    ],
  }

  const delta = diffGraphs(oldGraph, newGraph)
  assert.deepEqual(delta.nodes, {added: [], removed: []})
  assert.deepEqual(delta.edges, {added: 0, removed: 0})
})

test('graph diff keeps same-name overloads stable while reporting a real new symbol', () => {
  const oldGraph = {
    ...metadata,
    nodes: [
      {id: 'A.java', source_file: 'A.java'},
      {id: 'A.java#run@10', label: 'run()', source_file: 'A.java', source_location: 'L10', symbol_kind: 'method', complexity: {params: 1}},
      {id: 'A.java#run@30', label: 'run()', source_file: 'A.java', source_location: 'L30', symbol_kind: 'method', complexity: {params: 2}},
    ],
    links: [],
  }
  const newGraph = {
    ...metadata,
    nodes: [
      {id: 'A.java', source_file: 'A.java'},
      {id: 'A.java#run@14', label: 'run()', source_file: 'A.java', source_location: 'L14', symbol_kind: 'method', complexity: {params: 1}},
      {id: 'A.java#run@34', label: 'run()', source_file: 'A.java', source_location: 'L34', symbol_kind: 'method', complexity: {params: 2}},
      {id: 'A.java#stop@40', label: 'stop()', source_file: 'A.java', source_location: 'L40', symbol_kind: 'method', complexity: {params: 0}},
    ],
    links: [],
  }

  const delta = diffGraphs(oldGraph, newGraph)
  assert.deepEqual(delta.nodes.added, ['A.java#stop@40'])
  assert.deepEqual(delta.nodes.removed, [])
})
