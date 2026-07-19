import test from 'node:test'
import assert from 'node:assert/strict'
import {createSyncPayloadV3} from '../src/mcp/sync-payload.mjs'
import {graph, minimalEvidence} from './helpers/sync-payload-fixtures.js'

test('sync payload v3: duplicate evidence is source-free and strictly bounded', () => {
  const secret = 'PRIVATE_DUPLICATE_SOURCE_4d21'
  const absolute = 'C:\\Users\\Alice\\private.js'
  const evidence = minimalEvidence()
  const member = (groupIndex, memberIndex) => ({
    file: `src/module-${groupIndex}/file-${memberIndex}.js`,
    startLine: memberIndex * 10 + 1,
    endLine: memberIndex * 10 + 9,
    tokens: 80,
    graphNodeId: `src/module-${groupIndex}/file-${memberIndex}.js#run@${memberIndex * 10 + 1}`,
    source_text: secret,
    snippet: secret,
  })
  evidence.sections.duplicates = {
    state: 'COMPLETE', verdict: 'UNKNOWN', source_text: secret,
    thresholds: {clones: {mode: 'strict', minSimilarityPercent: 1, minTokens: 1}},
    completeness: {
      fragments: {total: 5000, eligible: 2000, filtered: 3000},
      cloneGroups: {total: 105, returned: 105, truncated: false},
      divergenceCandidates: {total: 105, returned: 105, truncated: false}, reasons: [],
    },
    cloneGroups: Array.from({length: 105}, (_, index) => ({
      id: (index + 1).toString(16).padStart(24, '0'), memberCount: 15, totalTokens: 1200,
      strongestSimilarity: 100, weakestLinkedSimilarity: 82,
      members: Array.from({length: 15}, (_, memberIndex) => member(index, memberIndex)),
      source_text: secret, absolutePath: absolute,
    })),
    divergenceCandidates: Array.from({length: 105}, (_, index) => ({
      id: (index + 1000).toString(16).padStart(24, '0'), symbol: `computePlan${index}`,
      similarity: 20, totalTokens: 160,
      members: [member(index + 200, 0), member(index + 200, 1)], snippet: secret,
    })),
  }

  const section = createSyncPayloadV3(graph(), evidence).evidence.sections.duplicates
  assert.equal(section.state, 'PARTIAL')
  assert.deepEqual(section.thresholds, {
    clones: {mode: 'renamed', minSimilarityPercent: 80, minTokens: 50},
    divergence: {sameName: true, maxSimilarityPercent: 45, minTokens: 50, maxImplementationsPerName: 12},
  })
  assert.equal(section.cloneGroups.length, 100)
  assert.ok(section.cloneGroups.every((group) => group.members.length === 12 && group.membersTruncated))
  assert.equal(section.divergenceCandidates.length, 100)
  assert.equal(section.completeness.cloneGroups.truncated, true)
  assert.equal(section.completeness.divergenceCandidates.truncated, true)
  assert.ok(section.completeness.reasons.includes('CLONE_MEMBERS_TRUNCATED'))
  const wire = JSON.stringify(section)
  assert.equal(wire.includes(secret), false)
  assert.equal(wire.includes(absolute), false)
  assert.equal(wire.includes('source_text'), false)
  assert.equal(wire.includes('snippet'), false)
})

test('sync payload v3: unknown graph and evidence fields cannot carry source or secrets', () => {
  const secret = 'PRIVATE_SOURCE_BODY_6dcf'
  const absolute = 'C:\\Users\\Alice\\.ssh\\id_rsa'
  const evidence = minimalEvidence({secret, source_text: secret, absolutePath: absolute})
  evidence.sections.architecture.secret = secret
  evidence.sections.health.source_text = secret
  evidence.sections.packages.absolutePath = absolute

  const payload = createSyncPayloadV3(graph({
    secret, source_text: secret, absolutePath: absolute,
    nodes: [{id: 'src/a.js', source_file: 'src/a.js', label: absolute, source_text: secret, secret}],
    links: [{source: 'src/a.js', target: 'src/a.js', relation: 'imports', specifier: absolute}],
  }), evidence)
  const wire = JSON.stringify(payload)
  assert.equal(payload.nodes[0].label, undefined)
  assert.equal(payload.links[0].specifier, undefined)
  assert.equal(wire.includes(secret), false)
  assert.equal(wire.includes(absolute), false)
  assert.equal(wire.includes('source_text'), false)
  assert.equal(wire.includes('absolutePath'), false)
})

test('sync payload v3: package dependency evidence is allowlisted and referentially bounded', () => {
  const secret = 'PRIVATE_PACKAGE_GRAPH_SECRET_7721'
  const evidence = minimalEvidence()
  const id = 'npm:left-pad@1.3.0:0123456789ab'
  const scopedId = 'npm:@scope/tool@2.0.0:abcdef012345'
  evidence.sections.packages.dependencyGraph = {
    state: 'COMPLETE', ecosystem: 'npm', lockfile: 'package-lock.json', lockfileVersion: 3, root: '(root)',
    absolutePath: 'C:\\Users\\Alice\\private.json', source_text: secret,
    completeness: {
      nodes: {total: 2, returned: 2, truncated: false},
      edges: {total: 2, returned: 2, truncated: false},
      declarations: {total: 2, resolved: 1, unresolved: 1, local: 0, optionalMissing: 0},
      reasons: ['UNRESOLVED_LOCKFILE_DEPENDENCIES'],
    },
    nodes: [
      {id, name: 'left-pad', version: '1.3.0', direct: true, source_text: secret},
      {id: scopedId, name: '@scope/tool', version: '2.0.0'},
      {id: `npm:bad@1.0.0:${secret}:0123456789ab`, name: 'bad', version: '1.0.0'},
    ],
    edges: [
      {from: '(root)', to: id, kind: 'runtime', source_text: secret},
      {from: id, to: scopedId, kind: 'optional-peer'},
      {from: '(root)', to: 'npm:missing@1.0.0:abcdefabcdef', kind: 'runtime'},
    ],
  }

  const payload = createSyncPayloadV3(graph(), evidence)
  assert.deepEqual(payload.evidence.sections.packages.dependencyGraph.nodes, [
    {id, name: 'left-pad', version: '1.3.0', direct: true, dev: false, optional: false, peer: false},
    {id: scopedId, name: '@scope/tool', version: '2.0.0', direct: false, dev: false, optional: false, peer: false},
  ])
  assert.deepEqual(payload.evidence.sections.packages.dependencyGraph.edges, [
    {from: '(root)', to: id, kind: 'runtime'},
    {from: id, to: scopedId, kind: 'optional-peer'},
  ])
  const wire = JSON.stringify(payload)
  assert.equal(wire.includes(secret), false)
  assert.equal(wire.includes('C:\\Users\\Alice'), false)
  assert.equal(wire.includes('source_text'), false)
})
