import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {buildGraphAtGitRef, resolveGitCommit} from '../src/analysis/git-ref-graph.js'
import {buildInternalGraph} from '../src/graph/internal-builder.js'

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8', windowsHide: true})
}

test('Git-ref graph builds an immutable baseline without changing the worktree', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'weavatrix-ref-test-'))
  t.after(() => rmSync(repo, {recursive: true, force: true}))
  assert.equal(git(repo, ['init', '-q']).status, 0)
  git(repo, ['config', 'user.name', 'Weavatrix Test'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, '.github', 'workflows'), {recursive: true})
  writeFileSync(join(repo, 'src', 'value.js'), 'export const value = 1\n')
  writeFileSync(join(repo, '.depcheckrc.yaml'), 'ignores: []\n')
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
  git(repo, ['add', '.'])
  assert.equal(git(repo, ['commit', '-qm', 'baseline']).status, 0)
  writeFileSync(join(repo, 'src', 'value.js'), 'export const value = 2\nexport const newer = true\n')

  const resolved = resolveGitCommit(repo, 'HEAD')
  assert.equal(resolved.ok, true)
  assert.equal(resolveGitCommit(repo, '--output=pwn').ok, false)

  const built = await buildGraphAtGitRef(repo, 'HEAD')
  assert.equal(built.ok, true, built.error)
  assert.ok(built.graph.nodes.some((node) => node.id === 'src/value.js'))
  assert.ok(built.graph.nodes.some((node) => node.id === '.depcheckrc.yaml'))
  assert.ok(built.graph.nodes.some((node) => node.id === '.github/workflows/ci.yml'))
  assert.ok(!built.graph.nodes.some((node) => String(node.label || '').includes('newer')))
  const live = await buildInternalGraph(repo)
  const visible = (graph) => [...new Set(graph.nodes.map((node) => String(node.id)).filter((id) => !id.includes('#')))].sort()
  assert.deepEqual(visible(built.graph), visible(live), 'immutable and live builds must use the same tracked/hidden inventory')
  assert.match(String(await import('node:fs').then(({readFileSync}) => readFileSync(join(repo, 'src', 'value.js'), 'utf8'))), /newer/)
})
