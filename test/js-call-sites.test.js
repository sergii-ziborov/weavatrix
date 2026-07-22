import {test} from 'node:test'
import assert from 'node:assert/strict'
import {findCallSites, findParameterList, grammarForFile, parseJsTs} from '../src/analysis/js-call-sites.js'

test('grammarForFile recognizes JS/TS extensions only', () => {
    assert.equal(grammarForFile('a.ts'), 'typescript')
    assert.equal(grammarForFile('a.js'), 'javascript')
    assert.equal(grammarForFile('a.tsx'), 'tsx')
    assert.equal(grammarForFile('a.py'), null)
})

test('findCallSites returns per-argument UTF-16 ranges for a call', async () => {
    const code = 'const r = getUser(id, opts)\n'
    const tree = await parseJsTs(code, 'javascript')
    const sites = findCallSites(tree, 'getUser', 1)
    assert.equal(sites.length, 1)
    assert.equal(sites[0].args.length, 2)
    assert.equal(sites[0].args[0].text, 'id')
    assert.equal(sites[0].args[1].text, 'opts')
    // byte-exact: the reported range must slice back to the argument text
    assert.equal(code.slice(sites[0].args[1].start.index, sites[0].args[1].end.index), 'opts')
    assert.equal(sites[0].args[0].start.char, code.indexOf('id'))
})

test('findCallSites matches method calls by the property name and flags spread', async () => {
    const code = 'svc.getUser(...args)\n'
    const tree = await parseJsTs(code, 'javascript')
    const sites = findCallSites(tree, 'getUser', 1)
    assert.equal(sites.length, 1)
    assert.equal(sites[0].hasSpread, true)
})

test('findCallSites does not match a different name or a different line', async () => {
    const code = 'getUser(1)\ngetOrder(2)\n'
    const tree = await parseJsTs(code, 'javascript')
    assert.equal(findCallSites(tree, 'getUser', 2).length, 0)
    assert.equal(findCallSites(tree, 'getOrder', 2).length, 1)
})

test('findParameterList locates the close paren for insertion', async () => {
    const code = 'function getUser(id, opts) {\n    return id\n}\n'
    const tree = await parseJsTs(code, 'javascript')
    const params = findParameterList(tree, 'getUser', 1)
    assert.equal(params.params.length, 2)
    // close points at the ')' so an insert-before lands inside the list
    assert.equal(code[params.close.index], ')')
    assert.equal(code.slice(0, params.close.index).endsWith('opts'), true)
})

test('findParameterList handles an empty parameter list', async () => {
    const code = 'function ping() {\n    return 1\n}\n'
    const tree = await parseJsTs(code, 'javascript')
    const params = findParameterList(tree, 'ping', 1)
    assert.equal(params.params.length, 0)
    assert.equal(code[params.close.index], ')')
})

test('findParameterList locates a TypeScript method with typed params', async () => {
    const code = 'class S {\n    getUser(id: string, opts: Opts): User {\n        return this.x\n    }\n}\n'
    const tree = await parseJsTs(code, 'typescript')
    const params = findParameterList(tree, 'getUser', 2)
    assert.equal(params.params.length, 2)
    assert.equal(params.params[0].text, 'id: string')
})
