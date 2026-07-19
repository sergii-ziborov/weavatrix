import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createEvidenceSnapshot} from '../src/mcp/evidence-snapshot.mjs'
import {sanitizeFinding} from '../src/mcp/evidence-snapshot.common.mjs'
import {buildDuplicatesSection} from '../src/mcp/evidence-snapshot.duplicates.mjs'
import {buildPackagesSection} from '../src/mcp/evidence-snapshot.inventory.mjs'
import {fixtureGraph, fixtureRepo} from './helpers/evidence-snapshot-fixtures.js'

test('evidence snapshot is canonical across shuffled graph arrays and separates edge classes', async () => {
    const repo = fixtureRepo()
    const secret = 'PRIVATE_SOURCE_BODY_9f4c'
    try {
        const graph = fixtureGraph(secret)
        const shuffled = {
            ...graph,
            nodes: [...graph.nodes].reverse(),
            links: [...graph.links].reverse(),
            externalImports: [...graph.externalImports].reverse(),
        }
        const first = await createEvidenceSnapshot({repoRoot: repo, graph})
        const second = await createEvidenceSnapshot({repoRoot: repo, graph: shuffled})
        assert.deepEqual(second, first)
        assert.match(first.snapshotHash, /^[a-f0-9]{64}$/)

        assert.deepEqual(first.sections.architecture.dependencies.runtime, [
            {from: 'src/api', to: 'src/ui', count: 1},
            {from: 'src/ui', to: 'src/api', count: 1},
        ])
        assert.deepEqual(first.sections.architecture.dependencies.typeOnly, [
            {from: 'src/ui', to: 'src/shared', count: 1},
        ])
        assert.deepEqual(first.sections.architecture.dependencies.compileOnly, [
            {from: 'src/shared', to: 'src/api', count: 1},
        ])
        assert.deepEqual(first.sections.architecture.cycles.map(({kind, members}) => ({kind, members})), [
            {kind: 'runtime', members: ['src/api/a.js', 'src/ui/b.js']},
            {kind: 'compile-time', members: ['src/api/a.js', 'src/shared/c.js', 'src/ui/b.js']},
        ])
        assert.deepEqual(first.sections.architecture.boundaryViolations, [{
            kind: 'forbidden', ruleId: 'api-to-ui', severity: 'high',
            from: 'src/api/a.js', to: 'src/ui/b.js',
        }])
        assert.deepEqual(first.sections.health.complexity.hotspots[0].breaches, [
            'CYCLOMATIC_HIGH', 'LOC_HIGH', 'PARAMS_HIGH',
        ])
        assert.equal(first.sections.health.complexity.hotspots[0].file, 'src/api/a.js')
        assert.deepEqual(first.sections.packages.directUsage, [{
            name: 'left-pad', ecosystem: 'npm', importCount: 2, fileCount: 2,
            files: ['src/api/a.js', 'src/ui/b.js'], filesTruncated: false, kinds: ['esm'],
        }])
        assert.ok(first.sections.packages.inventory.some((entry) =>
            entry.name === 'left-pad' && entry.version === '1.3.0' && entry.source === 'package-lock'))
        const packageGraph = first.sections.packages.dependencyGraph
        assert.equal(packageGraph.state, 'COMPLETE')
        assert.equal(packageGraph.lockfileVersion, 3)
        assert.equal(packageGraph.completeness.nodes.total, 4)
        const packageIds = new Map(packageGraph.nodes.map((entry) => [entry.name, entry.id]))
        assert.deepEqual(packageGraph.nodes.filter((entry) => entry.direct).map((entry) => entry.name), [
            'fixture-dev', 'fixture-optional', 'left-pad',
        ])
        assert.ok(packageGraph.edges.some((edge) =>
            edge.from === '(root)' && edge.to === packageIds.get('left-pad') && edge.kind === 'runtime'))
        assert.ok(packageGraph.edges.some((edge) =>
            edge.from === '(root)' && edge.to === packageIds.get('fixture-dev') && edge.kind === 'dev'))
        assert.ok(packageGraph.edges.some((edge) =>
            edge.from === '(root)' && edge.to === packageIds.get('fixture-optional') && edge.kind === 'optional'))
        assert.ok(packageGraph.edges.some((edge) =>
            edge.from === packageIds.get('left-pad') && edge.to === packageIds.get('repeat-string') && edge.kind === 'runtime'))
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('evidence snapshot preserves unknown checks and never emits source text, snippets, titles, or absolute paths', async () => {
    const repo = fixtureRepo()
    const secret = 'PRIVATE_SOURCE_BODY_9f4c'
    try {
        const snapshot = await createEvidenceSnapshot({repoRoot: repo, graph: fixtureGraph(secret)})
        assert.equal(snapshot.sections.health.checks.osv, 'NOT_CHECKED')
        assert.equal(snapshot.sections.packages.checks.osv, 'NOT_CHECKED')
        assert.equal(snapshot.sections.health.state, 'PARTIAL')
        assert.notEqual(snapshot.sections.health.verdict, 'PASS')
        assert.notEqual(snapshot.sections.packages.verdict, 'PASS')
        for (const finding of snapshot.sections.health.findings) {
            assert.equal(Object.hasOwn(finding, 'title'), false)
            assert.equal(Object.hasOwn(finding, 'detail'), false)
            assert.equal(Object.hasOwn(finding, 'fixHint'), false)
            assert.equal(Object.hasOwn(finding, 'evidence'), false)
        }

        const wire = JSON.stringify(snapshot)
        assert.equal(wire.includes(secret), false)
        assert.equal(wire.includes(repo.replace(/\\/g, '/')), false)
        assert.equal(wire.includes('C:/Users/Alice'), false)
        assert.equal(wire.includes('/home/alice'), false)
        assert.equal(wire.includes('source_text'), false)
        assert.equal(wire.includes('snippet'), false)
        assert.equal(wire.includes('C:/Users/Alice'), false)
        assert.equal(wire.includes('fixHint'), false)
        assert.equal(wire.includes('detail'), false)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('finding evidence drops path-shaped symbol text', () => {
    const finding = sanitizeFinding({
        id: 'a'.repeat(16), category: 'unused', rule: 'unused-export', severity: 'low',
        file: 'src/a.js', symbol: 'x=/home/alice/.ssh/id_rsa',
    })
    assert.equal(finding.symbol, undefined)
})

test('package evidence is COMPLETE and PASS when every bounded input and check is complete', () => {
    const repo = fixtureRepo()
    try {
        const section = buildPackagesSection(
            {installed: []},
            null,
            {externalImports: []},
            {findings: [], checks: {osv: {status: 'COMPLETE'}, malware: {status: 'NOT_APPLICABLE'}}},
            repo,
        )
        assert.equal(section.dependencyGraph.state, 'COMPLETE')
        assert.equal(section.state, 'COMPLETE')
        assert.equal(section.verdict, 'PASS')
        assert.deepEqual(section.completeness.reasons, [])
    } finally { rmSync(repo, {recursive: true, force: true}) }
})

test('duplicate evidence exposes stable source-free production review queues', () => {
    const repo = mkdtempSync(join(tmpdir(), 'weavatrix-duplicate-evidence-'))
    const clone = ({name, input, total, items, item, price, quantity}) => `export function ${name}(${input}) {
  let ${total} = Number(${input}.base || 0)
  const ${items} = Array.isArray(${input}.items) ? ${input}.items : []
  for (const ${item} of ${items}) {
    const ${price} = Number(${item}.price || 0)
    const ${quantity} = Number(${item}.quantity || 0)
    if (${price} > 0 && ${quantity} > 0) {
      ${total} += ${price} * ${quantity}
    } else if (${quantity} < 0) {
      ${total} -= Math.abs(${quantity})
    }
  }
  if (${input}.discount > 0) {
    ${total} = Math.max(0, ${total} - Number(${input}.discount))
  }
  return { total: ${total}, count: ${items}.length, valid: ${total} >= 0 }
}
`
    const firstClone = clone({
        name: 'firstClone', input: 'request', total: 'total', items: 'items', item: 'item', price: 'price', quantity: 'quantity',
    })
    const secondClone = clone({
        name: 'secondClone', input: 'payload', total: 'amount', items: 'records', item: 'record', price: 'cost', quantity: 'units',
    })
    const divergenceA = `export function calculatePlan(input) {
  let score = 0
  for (let index = 0; index < input.values.length; index += 1) {
    const value = Number(input.values[index] || 0)
    if (value > 10) score += value * index
    else if (value < 0) score -= Math.abs(value)
    else score += value + index
  }
  while (score > 1000) score = Math.floor(score / 2)
  return score > 100 ? score - 17 : score + 23
}
`
    const divergenceB = `export function calculatePlan(context) {
  try {
    const lookup = new Map(Object.entries(context.catalog || {}))
    const selected = [...lookup.keys()].filter(Boolean).sort().reverse()
    switch (context.strategy) {
      case 'first': return selected.shift()?.toUpperCase() ?? null
      case 'last': return selected.pop()?.toLowerCase() ?? null
      default: return JSON.stringify({ selected, lookup: lookup.size, ready: Boolean(context.ready) })
    }
  } catch (error) {
    return Promise.reject(error)
  }
}
`
    const files = new Map([
        ['src/product/clone-a.js', firstClone],
        ['src/product/clone-b.js', secondClone],
        ['src/product/plan-a.js', divergenceA],
        ['src/product/plan-b.js', divergenceB],
        ['test-e2e/clone.js', firstClone],
        ['src/__mocks__/clone.js', firstClone],
        ['src/generated/clone.js', `// auto-generated; do not edit\n${firstClone}`],
        ['src/view.stories.js', firstClone],
        ['ignored/clone.js', firstClone],
        ['docs/clones.md', `${firstClone}\n${secondClone}`],
    ])
    try {
        for (const [file, body] of files) {
            mkdirSync(join(repo, ...file.split('/').slice(0, -1)), {recursive: true})
            writeFileSync(join(repo, ...file.split('/')), body)
        }
        writeFileSync(join(repo, '.weavatrix.json'), JSON.stringify({exclude: ['ignored/**']}))
        const nodes = [...files.keys()]
            .filter((file) => file.endsWith('.js'))
            .map((file) => ({
                id: `${file}#${file.includes('plan-') ? 'calculatePlan' : file.includes('clone-b') ? 'secondClone' : 'firstClone'}@${file.includes('generated/') ? 2 : 1}`,
                label: file.includes('plan-') ? 'calculatePlan' : file.includes('clone-b') ? 'secondClone' : 'firstClone',
                source_file: file,
                source_location: `L${file.includes('generated/') ? 2 : 1}`,
            }))
        const first = buildDuplicatesSection(repo, {nodes})
        const second = buildDuplicatesSection(repo, {nodes: [...nodes].reverse()})
        assert.deepEqual(second, first)
        assert.equal(first.state, 'COMPLETE')
        assert.equal(first.verdict, 'UNKNOWN')
        assert.deepEqual(first.thresholds.clones, {mode: 'renamed', minSimilarityPercent: 80, minTokens: 50})
        const cloneGroup = first.cloneGroups.find((group) =>
            group.members.some((member) => member.file === 'src/product/clone-a.js'))
        assert.ok(cloneGroup)
        assert.match(cloneGroup.id, /^[a-f0-9]{24}$/)
        assert.equal(cloneGroup.weakestLinkedSimilarity >= 80, true)
        assert.deepEqual(cloneGroup.members.map((member) => member.file), [
            'src/product/clone-a.js',
            'src/product/clone-b.js',
        ])
        assert.ok(cloneGroup.members.every((member) => member.tokens >= 50))
        const divergence = first.divergenceCandidates.find((candidate) => candidate.symbol === 'calculatePlan')
        assert.ok(divergence)
        assert.match(divergence.id, /^[a-f0-9]{24}$/)
        assert.equal(divergence.similarity <= 45, true)
        assert.deepEqual(divergence.members.map((member) => member.file), [
            'src/product/plan-a.js',
            'src/product/plan-b.js',
        ])

        const wire = JSON.stringify(first)
        for (const noisy of ['test-e2e/', '__mocks__', 'generated/', '.stories.', 'ignored/', 'docs/']) {
            assert.equal(wire.includes(noisy), false)
        }
        assert.equal(wire.includes(repo.replace(/\\/g, '/')), false)
        assert.equal(wire.includes('let score = 0'), false)
        assert.equal(wire.includes('source_text'), false)
        assert.equal(wire.includes('snippet'), false)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})
