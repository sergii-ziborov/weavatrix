// Offline advisory cache. The MIT core plans source-free OSV coordinates, validates returned
// records and reads/writes the local cache, but never performs network I/O. A connector extension
// owns remote transport and passes bounded response data to commitAdvisoryRefresh().
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {join, dirname} from 'node:path'
import {homedir} from 'node:os'
import {createHash} from 'node:crypto'
import {uniqueBy} from '../util.js'

export const DEFAULT_STORE = join(homedir(), '.weavatrix', 'advisories.json')
const OSV_SUPPORTED_ECOSYSTEMS = new Set(['npm', 'PyPI', 'Go', 'Maven', 'crates.io'])

const keyOf = (ecosystem, name) => `${ecosystem}|${ecosystem === 'PyPI' ? String(name).toLowerCase().replace(/[-_.]+/g, '-') : name}`
const uniquePackages = (packages) => uniqueBy(packages, (item) => `${item.ecosystem}|${item.name}|${item.version}`)

export function createAdvisoryQueryPlan(installed = []) {
  const pinned = installed.filter((item) => item?.ecosystem && item?.name && item?.version)
  const unsupported = pinned.filter((item) => !OSV_SUPPORTED_ECOSYSTEMS.has(item.ecosystem)).length
  const packages = uniquePackages(pinned.filter((item) => OSV_SUPPORTED_ECOSYSTEMS.has(item.ecosystem)))
    .map(({ecosystem, name, version}) => ({ecosystem, name, version}))
  return Object.freeze({packages: Object.freeze(packages), unsupported})
}

export function advisoryQueryFingerprint(installed = []) {
  const rows = createAdvisoryQueryPlan(installed).packages
    .map((item) => `${item.ecosystem}|${item.name}|${item.version}`)
    .sort()
  return createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex')
}

export function loadStore(storePath = DEFAULT_STORE) {
  try {
    const store = JSON.parse(readFileSync(storePath, 'utf8'))
    if (store && typeof store === 'object' && store.records) return store
  } catch { /* missing/corrupt -> empty */ }
  return {meta: {fetched_at: null}, records: {}}
}

export const queryStore = (store, ecosystem, name) => (store?.records?.[keyOf(ecosystem, name)]) || []

export function storeMeta(storePath = DEFAULT_STORE) {
  const store = loadStore(storePath)
  return {
    fetchedAt: store.meta?.fetched_at || null,
    advisoryCount: Object.values(store.records || {}).reduce((total, records) => total + records.length, 0),
  }
}

function severityOf(record) {
  if (String(record.id || '').startsWith('MAL-')) return 'critical'
  const label = String(record.database_specific?.severity || '').toLowerCase()
  if (label === 'critical') return 'critical'
  if (label === 'high') return 'high'
  if (label === 'moderate' || label === 'medium') return 'medium'
  if (label === 'low') return 'low'
  let best = 0
  for (const severity of record.severity || []) {
    const value = String(severity.score || '')
    const match = /CVSS:[\d.]+\/.*?\bA[VC]?:/i.test(value) ? null : value.match(/^(\d+(?:\.\d+)?)$/)
    if (match) best = Math.max(best, Number(match[1]))
  }
  if (best >= 9) return 'critical'
  if (best >= 7) return 'high'
  return 'medium'
}

export function normalizeOsvAdvisory(record, ecosystem, name) {
  const affected = (record?.affected || []).find((item) => item?.package
    && item.package.ecosystem === ecosystem
    && keyOf(ecosystem, item.package.name) === keyOf(ecosystem, name))
  if (!affected) return null
  const fixed = []
  for (const range of affected.ranges || []) for (const event of range.events || []) if (event.fixed) fixed.push(event.fixed)
  return {
    id: record.id,
    kind: String(record.id || '').startsWith('MAL-') ? 'malicious' : 'vuln',
    severity: severityOf(record),
    summary: String(record.summary || record.details || '').slice(0, 300),
    modified: record.modified || '',
    aliases: (record.aliases || []).slice(0, 6),
    fixedIn: [...new Set(fixed)].slice(0, 4),
    affected: {versions: affected.versions || [], ranges: affected.ranges || []},
  }
}

// idsByPackage is an array parallel to plan.packages; advisoryRecords is an id-keyed plain object.
// Remote failures arrive explicitly in errors. A zero-response failure never stamps the cache fresh.
export function commitAdvisoryRefresh({
  plan,
  idsByPackage = [],
  advisoryRecords = {},
  queriedOk = 0,
  errors: initialErrors = [],
  storePath = DEFAULT_STORE,
  repoKey = '',
  repoKeys = [],
} = {}) {
  const packages = plan?.packages || []
  const unsupported = Number(plan?.unsupported) || 0
  if (!packages.length) return {ok: false, queried: 0, unsupported, error: 'No OSV-supported pinned package versions found to check.'}
  const errors = [...initialErrors.map(String)]
  if (errors.length && queriedOk === 0) {
    return {ok: false, queried: packages.length, unsupported, error: `advisory refresh failed: ${errors[0]}`, errors}
  }

  const store = loadStore(storePath)
  const wanted = new Map()
  idsByPackage.forEach((ids, index) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!wanted.has(id)) wanted.set(id, [])
      wanted.get(id).push(packages[index])
    }
  })

  let fetched = 0
  for (const [id, packageList] of wanted) {
    const record = advisoryRecords[id]
    if (!record || record.id !== id) {
      errors.push(`${id}: advisory detail response is missing or has a mismatched id`)
      continue
    }
    let normalized = 0
    for (const item of packageList) {
      const row = normalizeOsvAdvisory(record, item.ecosystem, item.name)
      if (!row) {
        errors.push(`${id}: advisory detail does not describe ${item.ecosystem}:${item.name}`)
        continue
      }
      normalized++
      const key = keyOf(item.ecosystem, item.name)
      const records = store.records[key] || (store.records[key] = [])
      const index = records.findIndex((existing) => existing.id === row.id)
      if (index >= 0) records[index] = row
      else records.push(row)
    }
    if (normalized) fetched++
  }

  const fetchedAt = new Date().toISOString()
  const status = errors.length ? 'PARTIAL' : 'OK'
  store.meta.fetched_at = fetchedAt
  const stampRepos = [...new Set([repoKey, ...repoKeys].filter(Boolean))]
  if (stampRepos.length) {
    store.meta.repos ||= {}
    for (const key of stampRepos) store.meta.repos[key] = {
      fetched_at: fetchedAt,
      status,
      queried: packages.length,
      queried_ok: queriedOk,
      unsupported,
      error_count: errors.length,
      query_fingerprint: advisoryQueryFingerprint(packages),
    }
  }
  try {
    mkdirSync(dirname(storePath), {recursive: true})
    writeFileSync(storePath, JSON.stringify(store), 'utf8')
  } catch (error) {
    return {ok: false, error: `store write failed: ${error.message}`, errors}
  }
  return {
    ok: true,
    status,
    queried: packages.length,
    queriedOk,
    unsupported,
    vulnerable: wanted.size,
    fetched,
    saved: existsSync(storePath),
    errors,
  }
}
