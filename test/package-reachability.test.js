import test from 'node:test'
import assert from 'node:assert/strict'
import {packageReachability} from '../src/analysis/package-reachability.js'

test('package reachability distinguishes product runtime, type-only, test-only and unknown', () => {
    const imports = [
        {pkg: 'runtime-pkg', file: 'src/app.ts', line: 2, kind: 'esm'},
        {pkg: 'types-pkg', file: 'src/types.ts', line: 1, kind: 'esm', typeOnly: true},
        {pkg: 'test-pkg', file: 'test/app.test.ts', line: 4, kind: 'esm'},
    ]
    const options = {isNonProductPath: (file) => file.startsWith('test/')}
    assert.equal(packageReachability(imports, 'runtime-pkg', options).state, 'DIRECT_RUNTIME_IMPORT')
    assert.equal(packageReachability(imports, 'types-pkg', options).state, 'TYPE_ONLY_IMPORT')
    assert.equal(packageReachability(imports, 'test-pkg', options).state, 'NON_PRODUCT_IMPORT_ONLY')
    const missing = packageReachability(imports, 'implicit-peer', options)
    assert.equal(missing.state, 'NOT_OBSERVED_IN_GRAPH')
    assert.match(missing.note, /remain unknown/)
})
