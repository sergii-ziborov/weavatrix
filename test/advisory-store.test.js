import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {
  advisoryQueryFingerprint, commitAdvisoryRefresh, createAdvisoryQueryPlan,
  loadStore, queryStore, storeMeta,
} from '../src/security/advisory-store.js'

const installed = [
  {ecosystem: 'npm', name: 'alpha', version: '1.0.0'},
  {ecosystem: 'PyPI', name: 'Beta_Pkg', version: '2.0.0'},
  {ecosystem: 'crates.io', name: 'gamma', version: '3.0.0'},
  {ecosystem: 'Unknown', name: 'delta', version: '4.0.0'},
]

test('offline core creates a stable, deduplicated OSV query plan without networking', () => {
  const plan = createAdvisoryQueryPlan([...installed, installed[0], {ecosystem: 'npm', name: 'floating'}])
  assert.equal(plan.packages.length, 3)
  assert.equal(plan.unsupported, 1)
  assert.deepEqual(plan.packages.map((item) => item.ecosystem), ['npm', 'PyPI', 'crates.io'])
  assert.equal(advisoryQueryFingerprint(installed), advisoryQueryFingerprint([...installed].reverse()))
})

test('offline core validates and commits connector-provided advisory records', () => {
  const parent = mkdtempSync(join(tmpdir(), 'weavatrix-advisory-cache-'))
  const storePath = join(parent, 'advisories.json')
  try {
    const plan = createAdvisoryQueryPlan(installed)
    const result = commitAdvisoryRefresh({
      plan,
      idsByPackage: [['GHSA-alpha'], [], []],
      advisoryRecords: {
        'GHSA-alpha': {
          id: 'GHSA-alpha', summary: 'bounded test record', database_specific: {severity: 'HIGH'},
          affected: [{package: {ecosystem: 'npm', name: 'alpha'}, ranges: [{events: [{fixed: '1.0.1'}]}]}],
        },
      },
      queriedOk: 3,
      storePath,
      repoKey: 'C:/repo',
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'OK')
    assert.equal(result.fetched, 1)
    assert.equal(queryStore(loadStore(storePath), 'npm', 'alpha')[0].severity, 'high')
    assert.equal(storeMeta(storePath).advisoryCount, 1)
    const raw = JSON.parse(readFileSync(storePath, 'utf8'))
    assert.equal(raw.meta.repos['C:/repo'].query_fingerprint, advisoryQueryFingerprint(plan.packages))
  } finally { rmSync(parent, {recursive: true, force: true}) }
})

test('remote failure cannot stamp an empty cache as fresh', () => {
  const parent = mkdtempSync(join(tmpdir(), 'weavatrix-advisory-failure-'))
  const storePath = join(parent, 'advisories.json')
  try {
    const result = commitAdvisoryRefresh({
      plan: createAdvisoryQueryPlan(installed), queriedOk: 0,
      errors: ['OSV unavailable'], storePath, repoKey: 'C:/repo',
    })
    assert.equal(result.ok, false)
    assert.equal(storeMeta(storePath).fetchedAt, null)
  } finally { rmSync(parent, {recursive: true, force: true}) }
})

test('malformed detail evidence remains PARTIAL instead of a clean zero', () => {
  const parent = mkdtempSync(join(tmpdir(), 'weavatrix-advisory-partial-'))
  const storePath = join(parent, 'advisories.json')
  try {
    const result = commitAdvisoryRefresh({
      plan: createAdvisoryQueryPlan(installed),
      idsByPackage: [['GHSA-missing'], [], []], advisoryRecords: {}, queriedOk: 3, storePath,
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'PARTIAL')
    assert.equal(result.fetched, 0)
    assert.ok(result.errors.length)
  } finally { rmSync(parent, {recursive: true, force: true}) }
})
