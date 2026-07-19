import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  GRAPH_BUILDER_VERSION,
  persistedFreshnessMatches,
  repositoryFreshnessProbe,
  stampRepositoryFreshness,
} from '../src/graph/freshness-probe.js'

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8', windowsHide: true})
  assert.equal(result.status, 0, result.stderr)
}

test('freshness probe is stable but detects rapid same-size dirty and untracked changes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'weavatrix-probe-'))
  try {
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'src', 'value.js'), 'export const value = 1\n')
    git(repo, ['init', '-q'])
    git(repo, ['add', '.'])
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'])
    const clean = repositoryFreshnessProbe(repo)
    assert.match(clean, /^[a-f0-9]{64}$/)
    assert.equal(repositoryFreshnessProbe(repo), clean)
    writeFileSync(join(repo, 'src', 'value.js'), 'export const value = 2\n')
    const dirty = repositoryFreshnessProbe(repo)
    assert.notEqual(dirty, clean)
    assert.equal(repositoryFreshnessProbe(repo), dirty)
    writeFileSync(join(repo, 'src', 'new.js'), 'export const extra = 1\n')
    assert.notEqual(repositoryFreshnessProbe(repo), dirty)
  } finally { rmSync(repo, {recursive: true, force: true}) }
})

test('freshness probe detects ignored control-file changes that Git status omits', () => {
  const repo = mkdtempSync(join(tmpdir(), 'weavatrix-probe-control-'))
  try {
    writeFileSync(join(repo, '.gitignore'), '.weavatrix.json\n')
    writeFileSync(join(repo, 'app.js'), 'export const app = 1\n')
    git(repo, ['init', '-q'])
    git(repo, ['add', '.'])
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'])
    const clean = repositoryFreshnessProbe(repo)
    writeFileSync(join(repo, '.weavatrix.json'), JSON.stringify({classify: {test: ['quality/**']}}))
    assert.notEqual(repositoryFreshnessProbe(repo), clean)
  } finally { rmSync(repo, {recursive: true, force: true}) }
})

test('persisted freshness stamp fails closed for mode, scope, schema, version, legacy and non-Git state', () => {
  const probe = 'a'.repeat(64)
  const graph = {
    extImportsV: 3,
    edgeTypesV: 2,
    edgeProvenanceV: 1,
    complexityV: 2,
    physicalFileLocV: 1,
    repoBoundaryV: 1,
    barrelResolutionV: 1,
    reExportOccurrencesV: 1,
    symbolSpacesV: 1,
    extractorSchemaV: 5,
    graphBuildMode: 'full',
    graphBuildScope: '',
  }
  assert.equal(stampRepositoryFreshness(graph, probe, 'full'), true)
  assert.equal(graph.repositoryFreshnessBuilderVersion, GRAPH_BUILDER_VERSION)
  assert.equal(persistedFreshnessMatches(JSON.parse(JSON.stringify(graph)), probe, 'full'), true)

  for (const mutate of [
    (copy) => { copy.repositoryFreshnessMode = 'no-tests' },
    (copy) => { copy.graphBuildScope = 'src' },
    (copy) => { copy.extractorSchemaV = 4 },
    (copy) => { copy.reExportOccurrencesV = 0 },
    (copy) => { copy.symbolSpacesV = 0 },
    (copy) => { copy.edgeProvenanceV = 0 },
    (copy) => { copy.physicalFileLocV = 0 },
    (copy) => { copy.repositoryFreshnessBuilderVersion = '0.0.0-legacy' },
    (copy) => { delete copy.repositoryFreshnessProbe },
  ]) {
    const copy = JSON.parse(JSON.stringify(graph))
    mutate(copy)
    assert.equal(persistedFreshnessMatches(copy, probe, 'full'), false)
  }

  const legacy = {...graph}
  assert.equal(stampRepositoryFreshness(legacy, null, 'full'), true)
  assert.equal(persistedFreshnessMatches(legacy, probe, 'full'), false)

  const nonGit = mkdtempSync(join(tmpdir(), 'weavatrix-probe-nongit-'))
  try { assert.equal(repositoryFreshnessProbe(nonGit), null) }
  finally { rmSync(nonGit, {recursive: true, force: true}) }
})
