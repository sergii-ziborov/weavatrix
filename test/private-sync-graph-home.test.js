import assert from 'node:assert/strict'
import {join, resolve} from 'node:path'
import test from 'node:test'
import {privateSyncGraphHome} from '../scripts/private-sync-graph-home.mjs'

test('private release sync reuses the default MCP repository registry', () => {
    const userHome = resolve('fixture-home')
    assert.equal(
        privateSyncGraphHome({userHome}),
        join(userHome, '.weavatrix', 'graphs'),
    )
})

test('private release sync honors an explicit graph registry override', () => {
    const configuredHome = resolve('custom-graphs')
    assert.equal(
        privateSyncGraphHome({configuredHome, userHome: resolve('ignored-home')}),
        configuredHome,
    )
})
