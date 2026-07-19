import {realpathSync} from 'node:fs'
import {isAbsolute, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {edgeProvenance} from '../../graph/edge-provenance.js'
import {isStructuralRelation} from '../../graph/relations.js'
import {isPathInside} from '../../repo-path.js'
import {JS_TS_FILE, endpoint, norm} from './contract.js'

const lineNumber = (value) => {
  const match = /L(\d+)/.exec(String(value || ''))
  return match ? Number(match[1]) : 0
}

export function repoFileFromLocation(repoRoot, location) {
  if (location?.file) {
    try {
      const root = realpathSync.native(repoRoot)
      const path = realpathSync.native(resolve(root, String(location.file)))
      if (!isPathInside(root, path)) return null
      const rel = relative(root, path)
      return rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? norm(rel) : null
    } catch { return null }
  }
  const uri = typeof location === 'string' ? location : location?.uri || location?.targetUri
  if (!uri || !String(uri).startsWith('file:')) return null
  try {
    const root = realpathSync.native(repoRoot)
    const path = realpathSync.native(fileURLToPath(uri))
    if (!isPathInside(root, path)) return null
    const rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return norm(rel)
  } catch { return null }
}

export function locationStart(location) {
  return location?.range?.start || location?.targetSelectionRange?.start
    || location?.targetRange?.start || null
}

const comparePosition = (left, right) => left.line - right.line || left.character - right.character

export function symbolIndex(graph) {
  const files = new Set()
  const byFile = new Map()
  for (const node of graph.nodes || []) {
    const id = String(node.id)
    const file = norm(node.source_file || (id.includes('#') ? id.slice(0, id.indexOf('#')) : id))
    if (!file) continue
    if (!id.includes('#')) files.add(file)
    else {
      const start = lineNumber(node.source_location) || Number(node.selection_start?.line) + 1 || 0
      const end = lineNumber(node.source_end) || start
      if (!start) continue
      const range = node.source_range
      const hasRange = Number.isInteger(range?.start?.line)
        && Number.isInteger(range?.start?.character)
        && Number.isInteger(range?.end?.line)
        && Number.isInteger(range?.end?.character)
      const rows = byFile.get(file) || []
      rows.push({id, start, end: Math.max(start, end), ...(hasRange ? {range} : {})})
      byFile.set(file, rows)
    }
  }
  for (const rows of byFile.values()) rows.sort((a, b) => {
    if (a.range && b.range) {
      return comparePosition(b.range.start, a.range.start)
        || comparePosition(a.range.end, b.range.end)
        || a.id.localeCompare(b.id)
    }
    return (a.end - a.start) - (b.end - b.start) || b.start - a.start || a.id.localeCompare(b.id)
  })
  return {files, byFile}
}

export function sourceAt(index, file, position) {
  if (!Number.isInteger(position?.line) || !Number.isInteger(position?.character)) {
    return index.files.has(file) ? file : null
  }
  const line = position.line + 1
  const rows = (index.byFile.get(file) || []).filter((row) => row.range
    ? comparePosition(row.range.start, position) <= 0 && comparePosition(position, row.range.end) < 0
    : row.start < line && line < row.end)
  if (rows.length) {
    const first = rows[0]
    const span = first.range ? null : first.end - first.start
    const tied = rows.filter((row) => {
      if (first.range || row.range) return Boolean(first.range && row.range
        && comparePosition(first.range.start, row.range.start) === 0
        && comparePosition(first.range.end, row.range.end) === 0)
      return row.end - row.start === span
    })
    if (tied.length === 1) return tied[0].id
  }
  return index.files.has(file) ? file : null
}

export function eligibleTargets(graph, limit, requestedIds = null) {
  const byId = new Map((graph.nodes || []).map((node) => [String(node.id), node]))
  if (Array.isArray(requestedIds) && requestedIds.length) {
    const ids = [...new Set(requestedIds.map(String))]
    const targets = ids.map((id) => byId.get(id))
      .filter((node) => node?.selection_start && JS_TS_FILE.test(String(node.source_file || '')))
      .slice(0, limit)
    return {targets, total: ids.length, orphanIds: new Set()}
  }
  const ranked = new Map()
  const inbound = new Set()
  for (const link of graph.links || []) {
    const relation = String(link.relation || '')
    if (!isStructuralRelation(relation)) inbound.add(endpoint(link.target))
    if (isStructuralRelation(relation)
      || !['calls', 'references', 'inherits', 'implements'].includes(relation)) continue
    if (edgeProvenance(link) === 'EXACT_LSP') continue
    const target = endpoint(link.target)
    const node = byId.get(target)
    if (!node?.selection_start || !JS_TS_FILE.test(String(node.source_file || ''))) continue
    const score = (relation === 'calls' ? 30 : relation === 'inherits' || relation === 'implements' ? 20 : 10)
      + (edgeProvenance(link) === 'INFERRED' ? 8 : 0)
    ranked.set(target, Math.max(ranked.get(target) || 0, score))
  }
  const orphans = new Set()
  for (const node of byId.values()) {
    const id = String(node.id)
    const visibility = String(node.visibility || '').toLowerCase()
    if (!node.selection_start || !JS_TS_FILE.test(String(node.source_file || '')) || inbound.has(id)) continue
    if (node.exported === true || visibility === 'public' || visibility === 'protected') continue
    if (!/\(\)$/.test(String(node.label || ''))
      && !['function', 'method', 'constructor'].includes(String(node.symbol_kind || '').toLowerCase())) continue
    if (!ranked.has(id)) { ranked.set(id, 4); orphans.add(id) }
  }
  const all = [...ranked.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const positive = all.filter(([id]) => !orphans.has(id))
  const orphan = all.filter(([id]) => orphans.has(id))
  const reserve = orphan.length ? Math.min(8, Math.ceil(limit / 4), limit) : 0
  const selected = positive.slice(0, Math.max(0, limit - reserve))
  selected.push(...orphan.slice(0, reserve))
  if (selected.length < limit) {
    const selectedIds = new Set(selected.map(([id]) => id))
    selected.push(...all.filter(([id]) => !selectedIds.has(id)).slice(0, limit - selected.length))
  }
  return {
    targets: selected.map(([id]) => byId.get(id)),
    total: all.length,
    orphanIds: new Set(orphan.map(([id]) => id)),
  }
}
