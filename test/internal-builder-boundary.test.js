import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildInternalGraph} from '../src/graph/internal-builder.js'

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rl-build-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative)
    mkdirSync(join(full, '..'), {recursive: true})
    writeFileSync(full, content)
  }
  return dir
}

test('internal-builder: a symlink/junction cycle does not make the walk recurse forever', async (t) => {
  const dir = repoWith({'src/a.js': 'export function a(){ return 1; }\n'})
  try { symlinkSync(dir, join(dir, 'src', 'loop'), 'junction') }
  catch { return t.skip('symlink/junction not permitted in this environment') }
  try {
    const startedAt = Date.now()
    const graph = await buildInternalGraph(dir)
    assert.ok(graph.nodes.some((node) => String(node.id).includes('#a@')), 'still indexes real files')
    assert.ok(Date.now() - startedAt < 15000, 'cycle-safe walk terminates')
  } finally { rmSync(dir, {recursive: true, force: true}) }
})

test('internal-builder: a symlink or junction cannot index files outside the repository', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'wx-build-boundary-'))
  const repo = join(parent, 'repo')
  const outside = join(parent, 'outside')
  mkdirSync(join(repo, 'src'), {recursive: true})
  mkdirSync(outside)
  writeFileSync(join(repo, 'src', 'inside.js'), 'export function inside(){ return 1; }\n')
  writeFileSync(join(outside, 'secret.js'), 'export function outsideSecret(){ return 2; }\n')
  try {
    try { symlinkSync(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return t.skip(`link creation is unavailable: ${error.code}`)
      throw error
    }
    const graph = await buildInternalGraph(repo)
    assert.ok(graph.nodes.some((node) => String(node.id).includes('#inside@')))
    assert.ok(!graph.nodes.some((node) => String(node.id).includes('outsideSecret') || String(node.source_file).includes('linked')))
  } finally { rmSync(parent, {recursive: true, force: true}) }
})
