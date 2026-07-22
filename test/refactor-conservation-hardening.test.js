// Regression tests for the adversarial-review findings: every scenario below previously
// produced a false CONSERVED (or an order-dependent/false-blocker verdict).

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {verifyRefactorConservation} from '../src/analysis/refactor-conservation.js'

const graph = (nodes, links) => ({nodes, links})
const sym = (id, label, file) => ({id, label, source_file: file})
const link = (source, target, type = 'calls') => ({source, target, type})

test('a deleted same-name overload cannot hide behind its surviving sibling', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper(a)', 'a.js'), sym('a.js#helper@20', 'helper(a, b)', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1'), link('b.js#main@1', 'a.js#helper@20')],
    )
    const current = graph(
        [sym('a.js#helper@1', 'helper(a)', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CONSERVED_WITH_WARNINGS')
    assert.equal(result.warnings[0].kind, 'DECLARATION_COUNT_SHRUNK')
    assert.equal(result.warnings[0].before, 2)
    assert.equal(result.warnings[0].after, 1)
})

test('a recycled old name cannot stand in for a declared-renamed caller', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('c.js#run@1', 'run', 'c.js')],
        [link('c.js#run@1', 'a.js#helper@1')],
    )
    // c.js#run was renamed to execute and LOST its call; an unrelated new 'run' calls helper
    const current = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('c.js#execute@1', 'execute', 'c.js'), sym('c.js#run@40', 'run', 'c.js')],
        [link('c.js#run@40', 'a.js#helper@1')],
    )
    const result = verifyRefactorConservation({
        baselineGraph: baseline,
        currentGraph: current,
        renames: [{oldName: 'run', newName: 'execute', file: 'c.js'}],
    })
    assert.equal(result.status, 'CALLERS_LOST')
    assert.equal(result.blockers, 1)
})

test('file-scoped renames take precedence over unscoped ones regardless of array order', () => {
    const baseline = graph(
        [sym('f1.js#x@1', 'x', 'f1.js'), sym('f2.js#x@1', 'x', 'f2.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'f1.js#x@1'), link('b.js#main@1', 'f2.js#x@1')],
    )
    const current = graph(
        [sym('f1.js#y@1', 'y', 'f1.js'), sym('f2.js#z@1', 'z', 'f2.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'f1.js#y@1'), link('b.js#main@1', 'f2.js#z@1')],
    )
    // unscoped rename first: previously shadowed the scoped one and broke f2.js matching
    const result = verifyRefactorConservation({
        baselineGraph: baseline,
        currentGraph: current,
        renames: [{oldName: 'x', newName: 'y'}, {oldName: 'x', newName: 'z', file: 'f2.js'}],
    })
    assert.equal(result.status, 'CONSERVED')
})

test('losing the calls edge is a loss even when a references edge to the same symbol survives', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1', 'calls'), link('b.js#main@1', 'a.js#helper@1', 'references')],
    )
    const current = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1', 'references')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CALLERS_LOST')
    assert.equal(result.symbols[0].lost[0].type, 'calls')
})

test('a baseline this matcher cannot index at all is UNPROVEN, never blessed', () => {
    const baseline = graph(
        [sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'ghost#gone@1')],
    )
    const current = graph([sym('b.js#main@1', 'main', 'b.js')], [])
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'UNPROVEN')
    assert.equal(result.coverage.skipped, 1)
})

test('a partially indexable baseline is CONSERVED_WITH_WARNINGS with the skip count', () => {
    const baseline = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1'), link('b.js#main@1', 'ghost#gone@1')],
    )
    const current = graph(
        [sym('a.js#helper@1', 'helper', 'a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'a.js#helper@1')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CONSERVED_WITH_WARNINGS')
    assert.ok(result.warnings.some((warning) => warning.kind === 'INCOMPLETE_BASELINE_INDEX'))
})

test('label-less nodes keyed from their id never leak the @line into identity', () => {
    const baseline = graph(
        [{id: 'a.js#helper@10', source_file: 'a.js'}, {id: 'b.js#main@5', source_file: 'b.js'}],
        [link('b.js#main@5', 'a.js#helper@10')],
    )
    const current = graph(
        [{id: 'a.js#helper@42', source_file: 'a.js'}, {id: 'b.js#main@77', source_file: 'b.js'}],
        [link('b.js#main@77', 'a.js#helper@42')],
    )
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.status, 'CONSERVED')
})

test('blockers count every loss even past the reported-list cap', () => {
    const baselineNodes = [sym('a.js#hub@1', 'hub', 'a.js')]
    const baselineLinks = []
    for (let index = 0; index < 250; index += 1) {
        baselineNodes.push(sym(`c${index}.js#f@1`, 'f', `c${index}.js`))
        baselineLinks.push(link(`c${index}.js#f@1`, 'a.js#hub@1'))
    }
    const baseline = graph(baselineNodes, baselineLinks)
    const current = graph([sym('a.js#hub@1', 'hub', 'a.js')], [])
    const result = verifyRefactorConservation({baselineGraph: baseline, currentGraph: current})
    assert.equal(result.blockers, 250)
    assert.ok(result.symbols[0].lost.length <= 200)
    assert.equal(result.symbols[0].lostCount, 250)
})

test('a rename scoped to the DESTINATION file of a combined move+rename still applies, and moves compose', () => {
    const baseline = graph(
        [sym('old/a.js#getUser@1', 'getUser', 'old/a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'old/a.js#getUser@1')],
    )
    const current = graph(
        [sym('final/a.js#getCustomer@1', 'getCustomer', 'final/a.js'), sym('b.js#main@1', 'main', 'b.js')],
        [link('b.js#main@1', 'final/a.js#getCustomer@1')],
    )
    const result = verifyRefactorConservation({
        baselineGraph: baseline,
        currentGraph: current,
        renames: [{oldName: 'getUser', newName: 'getCustomer', file: 'final/a.js'}],
        moves: [{fromFile: 'old/a.js', toFile: 'mid/a.js'}, {fromFile: 'mid/a.js', toFile: 'final/a.js'}],
    })
    assert.equal(result.status, 'CONSERVED')
})
