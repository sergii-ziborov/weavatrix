import {createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {computeDuplicates} from './duplicates.js'
import {withGitRefCheckout} from './git-ref-graph.js'
import {buildInternalGraph} from '../graph/internal-builder.js'
import {filterGraphForMode} from '../graph/graph-filter.js'

const NON_PRODUCT = new Set(['generated', 'mock', 'story', 'docs', 'benchmark', 'temp'])
const eligible = (fragment, settings) => {
  const classes = new Set(fragment.classes || [])
  if (fragment.n < settings.tokMin) return false
  if (settings.skipTests && (fragment.test || classes.has('test') || classes.has('e2e'))) return false
  return settings.includeClassified || !(fragment.excluded || [...classes].some((name) => NON_PRODUCT.has(name)))
}

function groupPairs(data, settings) {
  const fragments = data.frags || []
  const pairs = (data.modes?.[settings.mode] || []).filter(([a, b, similarity]) => similarity >= settings.simMin && eligible(fragments[a], settings) && eligible(fragments[b], settings))
  const parent = new Map()
  const find = (value) => { let root = value; while (parent.get(root) !== root) root = parent.get(root); return root }
  for (const [a, b] of pairs) {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    parent.set(find(a), find(b))
  }
  const groups = new Map()
  for (const [a, b, similarity] of pairs) {
    const root = find(a)
    if (!groups.has(root)) groups.set(root, {members: new Set(), maxSim: 0})
    const group = groups.get(root)
    group.members.add(a); group.members.add(b); group.maxSim = Math.max(group.maxSim, similarity)
  }
  return [...groups.values()].map((group) => {
    const members = [...group.members].map((index) => fragments[index]).sort((a, b) => b.n - a.n)
    return {members, maxSim: group.maxSim, tokens: members.reduce((sum, item) => sum + item.n, 0)}
  }).sort((a, b) => b.tokens - a.tokens)
}

export function isFrameworkBoilerplateCloneGroup(group) {
  const members = Array.isArray(group?.members) ? group.members : []
  if (members.length < 2) return false
  return members.every((member) => /(?:^|\/)\w[^/]*\.router\.[cm]?[jt]s$/i.test(String(member.file || '').replace(/\\/g, '/'))
    && /^(?:router|routes)\(?\)?$/i.test(String(member.label || '').trim()))
}

export function analyzeDuplicateGroups(repoRoot, graphPath, args = {}) {
  const settings = {
    simMin: Math.min(100, Math.max(50, Number(args.min_similarity) || 80)),
    tokMin: Math.min(400, Math.max(12, Number(args.min_tokens) || 50)),
    mode: args.mode === 'strict' ? 'strict' : 'renamed',
    skipTests: args.include_tests !== true,
    includeClassified: args.include_classified === true || args.include_non_product === true,
    includeBoilerplate: args.include_boilerplate === true,
  }
  const data = computeDuplicates(repoRoot, graphPath, {includeStrings: args.include_strings === true, minTokens: settings.tokMin})
  const allGroups = groupPairs(data, settings)
  const groups = settings.includeBoilerplate ? allGroups : allGroups.filter((group) => !isFrameworkBoilerplateCloneGroup(group))
  const suppressed = (data.frags || []).filter((fragment) => !eligible(fragment, settings)).length
  return {settings, groups, suppressed, boilerplateSuppressed: allGroups.length - groups.length}
}

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20)
function groupKey(group, mode) {
  const members = group.members.map((fragment) => {
    const fingerprints = Array.isArray(fragment.fp?.[mode]) ? [...fragment.fp[mode]].sort() : []
    return `${String(fragment.file).replace(/\\/g, '/')}\0${fragment.label || ''}\0${digest(JSON.stringify(fingerprints))}`
  }).sort()
  return digest(members.join('\n'))
}

export async function compareDuplicateGroups({repoRoot, graphPath, currentGraph, baseRef, changedFiles = [], args = {}}) {
  const current = analyzeDuplicateGroups(repoRoot, graphPath, args)
  const mode = ['full', 'no-tests', 'tests-only'].includes(currentGraph?.graphBuildMode) ? currentGraph.graphBuildMode : 'full'
  const baseline = await withGitRefCheckout(repoRoot, baseRef, async (checkout) => {
    let graph = await buildInternalGraph(checkout)
    if (mode !== 'full') graph = filterGraphForMode(graph, mode, {repoRoot: checkout})
    graph.graphBuildMode = mode
    const baselineGraphPath = join(checkout, '.weavatrix-verified-graph.json')
    writeFileSync(baselineGraphPath, JSON.stringify(graph))
    return analyzeDuplicateGroups(checkout, baselineGraphPath, args)
  })
  if (!baseline.ok) return {state: 'UNKNOWN', reason: baseline.error, currentGroups: current.groups.length}
  const baselineKeys = new Set(baseline.value.groups.map((group) => groupKey(group, current.settings.mode)))
  const changed = new Set(changedFiles.map((file) => String(file).replace(/\\/g, '/')))
  const added = current.groups.filter((group) => !baselineKeys.has(groupKey(group, current.settings.mode)))
  const scoped = added.filter((group) => group.members.some((member) => changed.has(String(member.file).replace(/\\/g, '/'))))
  return {
    state: scoped.length ? 'BLOCKED' : 'PASS', baseline: {ref: baseline.ref, commit: baseline.commit},
    currentGroups: current.groups.length, baselineGroups: baseline.value.groups.length, newGroups: added.length,
    scopedNewGroups: scoped.slice(0, 20).map((group) => ({similarity: group.maxSim, tokens: group.tokens, members: group.members.slice(0, 8).map((item) => ({file: item.file, start: item.start, end: item.end, label: item.label}))})),
  }
}
