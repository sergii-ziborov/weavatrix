import assert from 'node:assert/strict'
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const filesUnder = (directory) => {
  const found = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else found.push(path)
  }
  return found
}

test('published MIT core has no outbound HTTP implementation or network configuration surface', () => {
  const removed = [
    'src/mcp/actions/advisories.mjs',
    'src/mcp/actions/graph-sync.mjs',
    'src/mcp/actions/hosted-architecture.mjs',
    'scripts/sync-private.mjs',
  ]
  for (const relative of removed) assert.equal(existsSync(join(ROOT, relative)), false, relative)

  for (const path of filesUnder(join(ROOT, 'src')).filter((file) => /\.(?:mjs|js)$/.test(file))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\bfetch\s*\(/, `outbound fetch path in ${path}`)
  }

  const server = readFileSync(join(ROOT, 'server.json'), 'utf8')
  const manifest = readFileSync(join(ROOT, 'mcpb', 'manifest.json'), 'utf8')
  for (const text of [server, manifest]) {
    assert.doesNotMatch(text, /WEAVATRIX_SYNC_(?:URL|TOKEN)/)
    assert.doesNotMatch(text, /refresh_advisories|preview_sync|sync_graph|pull_architecture_contract/)
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.scripts['sync:private'], undefined)
})
