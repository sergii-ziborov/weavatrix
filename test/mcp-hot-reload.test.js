import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import {join} from 'node:path'
import {HOT_FILES} from '../src/mcp/catalog.mjs'
import {PROJECT_ROOT, startServer} from './helpers/mcp-stdio-fixture.js'

const initialize = async (server) => {
  await server.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: {name: 'weavatrix-hot-reload-test', version: '1.0.0'},
  })
  server.notify('notifications/initialized')
}

const replaceOwnerSource = (path, before, after, futureOffsetMs) => {
  const source = readFileSync(path, 'utf8')
  assert.match(source, new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  writeFileSync(path, source.replace(before, after))
  const future = new Date(Date.now() + futureOffsetMs)
  utimesSync(path, future, future)
}

test('hot reload watches every direct owner introduced by facade splits', () => {
  const owners = [
    'graph/tools-core.mjs', 'graph/tools-query.mjs', 'tools-graph-hubs.mjs',
    'health/duplicates.mjs', 'health/dead-code.mjs', 'health/audit-format.mjs',
    'health/audit.mjs', 'health/structure.mjs', 'health/endpoints.mjs',
    'actions/graph-lifecycle.mjs',
    'architecture-starter.mjs', 'architecture-bootstrap.mjs',
  ]
  for (const owner of owners) assert.ok(HOT_FILES.includes(owner), owner)
})

test('live stdio reload reaches graph and nested architecture owner modules', {timeout: 120_000}, async () => {
  const parent = mkdtempSync(join(PROJECT_ROOT, '.mcp-owner-hot-reload-'))
  const stagedSrc = join(parent, 'src')
  const stagedServer = join(stagedSrc, 'mcp-server.mjs')
  const repo = join(parent, 'repo')
  const graphPath = join(parent, 'graph', 'graph.json')
  const graphHome = join(parent, 'graph-home')
  cpSync(join(PROJECT_ROOT, 'src'), stagedSrc, {recursive: true})
  cpSync(join(PROJECT_ROOT, 'package.json'), join(parent, 'package.json'))
  mkdirSync(join(repo, 'src'), {recursive: true})
  writeFileSync(join(repo, 'src', 'service.js'), 'export function service() { return 1 }\n')

  const server = startServer(
    graphPath, repo, graphHome, {WEAVATRIX_PRECISION: 'off'}, 'offline', stagedServer,
  )
  try {
    await initialize(server)
    const rebuilt = await server.request('tools/call', {
      name: 'rebuild_graph', arguments: {precision: 'off'},
    })
    assert.equal(rebuilt.isError, undefined, server.stderr())

    const queryArgs = {question: 'service', seed_files: ['src/service.js'], depth: 1}
    const initialQuery = await server.request('tools/call', {
      name: 'query_graph', arguments: queryArgs,
    })
    assert.match(initialQuery.content[0].text, /Path policy: production-first/)

    replaceOwnerSource(
      join(stagedSrc, 'mcp', 'graph', 'tools-query.mjs'),
      'Path policy: production-first', 'Path policy: owner-hot-reloaded', 5_000,
    )
    const reloadedQuery = await server.request('tools/call', {
      name: 'query_graph', arguments: queryArgs,
    })
    assert.match(reloadedQuery.content[0].text, /Path policy: owner-hot-reloaded/)

    const initialArchitecture = await server.request('tools/call', {
      name: 'get_architecture_contract', arguments: {output_format: 'json'},
    })
    assert.equal(initialArchitecture.structuredContent.result.starterContract.budgets.maxFileLoc, 300)

    replaceOwnerSource(
      join(stagedSrc, 'mcp', 'architecture-starter.mjs'),
      'maxFileLoc: 300,', 'maxFileLoc: 299,', 10_000,
    )
    const reloadedPreview = await server.request('tools/call', {
      name: 'get_architecture_contract',
      arguments: {action: 'preview', baseline_mode: 'none', output_format: 'json'},
    })
    assert.equal(reloadedPreview.structuredContent.result.materializedContract.budgets.maxFileLoc, 299)
    assert.match(server.stderr(), /hot-reloaded tool implementations from changed source/)
  } finally {
    await server.stop()
    rmSync(parent, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
  }
})
