import {test} from 'node:test'
import assert from 'node:assert/strict'
import {verifyRefactorConservation} from '../src/analysis/refactor-conservation.js'

const graph = (nodes, links) => ({nodes, links})
const sym = (id, label, file) => ({id, label, source_file: file})
const link = (source, target, type = 'calls') => ({source, target, type})

test('line-shift id churn alone never reports losses', () => {
    const baseline = graph(
        [sym('a.js#helper@10', 'helper', 'a.js'), sym('b.js#main@5', 'main', 'b.js')],
        [link('b.js#main@5', 'a.js#helper@10')],
    )
    // every id changed its line, names and edges intact
    const current = graph(
        [sym('a.js#helper@22', 'helper', 'a.js'), sym('b.js#main@9', 'main', 'b.js')],
        [link('b.js#main@9', 'a.js#helper@22')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CONSERVED')
    assert.equal(result.blockers, 0)
    assert.equal(result.checked, 1)
})

test('a renamed symbol is compared against its new identity, not a ghost', () => {
    const baseline = graph(
        [sym('a.js#getUser@1', 'getUser', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#getUser@1')],
    )
    const current = graph(
        [sym('a.js#getCustomer@1', 'getCustomer', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#getCustomer@1')],
    )
    const result = verifyRefactorConservation({
        baselineGraph: baseline,
        currentGraph: current,
        renames: [{oldName: 'getUser', newName: 'getCustomer', file: 'a.js'}],
    })
    assert.equal(result.status, 'CONSERVED')
})

test('a genuinely lost caller blocks with the exact caller named', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#main@1', 'main', 'b.js'), sym('c.js#other@1', 'other', 'c.js')],
        [link('b.js#main@1', 'a.js#helper@1'), link('c.js#other@1', 'a.js#helper@1')],
    )
    // the refactor silently dropped c.js's call
    const current = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#main@1', 'main', 'b.js'), sym('c.js#other@1', 'other', 'c.js')],
        [link('b.js#main@1', 'a.js#helper@1')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CALLERS_LOST')
    assert.equal(result.blockers, 1)
    assert.deepEqual(result.symbols[0].lost, [{file: 'c.js', name: 'other', type: 'calls'}])
    assert.equal(result.symbols[0].conserved, 1)
})

test('a caller that was itself renamed still counts as conserved through the mapping', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#getUser@1', 'getUser', 'b.js')],
        [link('b.js#getUser@1', 'a.js#helper@1')],
    )
    const current = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#getCustomer@1', 'getCustomer', 'b.js')],
        [link('b.js#getCustomer@1', 'a.js#helper@1')],
    )
    const result = verifyRefactorConservation({
        baselineGraph: baseline,
        currentGraph: current,
        renames: [{oldName: 'getUser', newName: 'getCustomer', file: 'b.js'}],
    })
    assert.equal(result.status, 'CONSERVED')
})

test('a moved symbol conserves callers through the file mapping', () => {
    const baseline = graph(
        [sym('old/util.js#helper@1', 'helper', 'old/util.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'old/util.js#helper@1')],
    )
    const current = graph(
        [sym('new/util.js#helper@1', 'helper', 'new/util.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'new/util.js#helper@1')],
    )
    const result = verifyRefactorConservation({
        baselineGraph: baseline,
        currentGraph: current,
        moves: [{fromFile: 'old/util.js', toFile: 'new/util.js'}],
    })
    assert.equal(result.status, 'CONSERVED')
})

test('a symbol that vanished entirely is SYMBOLS_MISSING with its caller count', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1')],
    )
    const current = graph([sym('b.js#main@1', 'main', 'b.js')], [])
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'SYMBOLS_MISSING')
    assert.equal(result.missingSymbols[0].name, 'helper')
    assert.equal(result.missingSymbols[0].baselineCallers, 1)
})

test('structural containment edges are never treated as callers', () => {
    const baseline = graph(
        [sym('a.js', 'a.js', 'a.js'), sym('a.js#helper@1', 'helper', 'a.js')],
        [link('a.js', 'a.js#helper@1', 'contains')],
    )
    const current = graph(
        [sym('a.js', 'a.js', 'a.js'), sym('a.js#helper@1', 'helper', 'a.js')],
        [],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CONSERVED')
    assert.equal(result.checked, 0)
})

test('paths with spaces cannot collide in the composite key', () => {
    const baseline = graph(
        [sym('my dir/a.js#x@1', 'x', 'my dir/a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'my dir/a.js#x@1')],
    )
    const current = graph(
        [sym('my dir/a.js#x@1', 'x', 'my dir/a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'my dir/a.js#x@1')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CONSERVED')
})

test('new callers are information, never blockers; method labels with signatures match by bare name', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper(a, b)', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1')],
    )
    const current = graph(
        [sym('a.js#helper@1', 'helper(a, b, c)', 'a.js'), sym('b.js#main@1', 'main', 'b.js'), sym('c.js#extra@1', 'extra', 'c.js')],
        [link('b.js#main@1', 'a.js#helper@1'), link('c.js#extra@1', 'a.js#helper@1')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CONSERVED')
    assert.equal(result.blockers, 0)
})
