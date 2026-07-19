import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, mkdirSync, realpathSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {createRequire} from 'node:module'
import {
  trustedGrammarWasm, trustedRuntimeWasm, verifyParserArtifact,
} from '../src/graph/parser-artifact-boundary.js'
import {ensureParser} from '../src/graph/internal-builder.langs.js'

const require = createRequire(import.meta.url)

test('parser artifact boundary accepts an exact contained file and rejects tampering or escape', () => {
  const parent = mkdtempSync(join(tmpdir(), 'weavatrix-parser-boundary-'))
  const root = join(parent, 'pinned')
  mkdirSync(root)
  const file = join(root, 'runtime.wasm')
  writeFileSync(file, 'trusted parser bytes')
  const sha256 = createHash('sha256').update('trusted parser bytes').digest('hex')
  assert.equal(verifyParserArtifact({file, root, sha256}), realpathSync.native(file))
  assert.throws(() => verifyParserArtifact({file, root, sha256: '0'.repeat(64)}), /integrity check/)
  const outside = join(parent, 'outside.wasm')
  writeFileSync(outside, 'trusted parser bytes')
  assert.throws(() => verifyParserArtifact({file: outside, root, sha256}), /outside/)
})

test('installed runtime and grammar match the release-pinned integrity allowlist', () => {
  const wtsDir = dirname(require.resolve('web-tree-sitter'))
  const wasmDir = join(dirname(wtsDir), 'tree-sitter-wasms', 'out')
  assert.match(trustedRuntimeWasm(wtsDir), /tree-sitter\.wasm$/)
  assert.match(trustedGrammarWasm(wasmDir, 'javascript'), /tree-sitter-javascript\.wasm$/)
  assert.throws(() => trustedGrammarWasm(wasmDir, 'repository-controlled'), /unsupported/)
})

test('graph builder refuses custom runtime and grammar locations', async () => {
  await assert.rejects(ensureParser({runtimeWasm: 'remote.wasm'}, new Set()), /custom parser artifacts/)
  await assert.rejects(ensureParser({wasmDir: 'repo-grammars'}, new Set()), /custom parser artifacts/)
})
