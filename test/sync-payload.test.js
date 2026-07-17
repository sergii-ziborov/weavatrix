import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSyncPayload,
  createSyncPayloadV3,
  MAX_SYNC_EXTERNAL_IMPORTS,
  MAX_SYNC_LINKS,
  MAX_SYNC_NODES,
} from '../src/mcp/sync-payload.mjs'

function graph(overrides = {}) {
  return {
    repoBoundaryV: 1,
    edgeTypesV: 2,
    edgeProvenanceV: 1,
    extImportsV: 2,
    complexityV: 1,
    nodes: [],
    links: [],
    externalImports: [],
    ...overrides,
  }
}

function minimalEvidence(overrides = {}) {
  const emptyCompleteness = {total: 0, returned: 0, truncated: false}
  return {
    evidenceSnapshotV: 1,
    state: 'PARTIAL',
    snapshotHash: 'a'.repeat(64),
    sections: {
      architecture: {
        state: 'COMPLETE',
        verdict: 'PASS',
        completeness: {
          modules: emptyCompleteness,
          runtimeDependencies: emptyCompleteness,
          typeOnlyDependencies: emptyCompleteness,
          compileOnlyDependencies: emptyCompleteness,
          cycles: emptyCompleteness,
          boundaryViolations: emptyCompleteness,
          reasons: [],
        },
        modules: [],
        dependencies: {runtime: [], typeOnly: [], compileOnly: []},
        cycles: [],
        boundaryViolations: [],
      },
      duplicates: {
        state: 'COMPLETE',
        verdict: 'UNKNOWN',
        thresholds: {
          clones: {mode: 'renamed', minSimilarityPercent: 80, minTokens: 50},
          divergence: {sameName: true, maxSimilarityPercent: 45, minTokens: 50, maxImplementationsPerName: 12},
        },
        completeness: {
          fragments: {total: 0, eligible: 0, filtered: 0},
          cloneGroups: emptyCompleteness,
          divergenceCandidates: emptyCompleteness,
          reasons: [],
        },
        cloneGroups: [],
        divergenceCandidates: [],
      },
      health: {
        state: 'PARTIAL',
        verdict: 'UNKNOWN',
        completeness: {
          findings: emptyCompleteness,
          hotspots: emptyCompleteness,
          complexity: {analyzed: 0},
          reasons: ['OPTIONAL_CHECKS_INCOMPLETE'],
        },
        summary: {
          bySeverity: {},
          byCategory: {},
          dead: {},
          structure: {},
        },
        checks: {osv: 'NOT_CHECKED', malware: 'NOT_APPLICABLE'},
        findings: [],
        complexity: {
          thresholds: {
            loc: {warning: 120, high: 300},
            cyclomatic: {warning: 15, high: 30},
            params: {warning: 6, high: 10},
          },
          analyzed: 0,
          hotspots: [],
        },
      },
      technologies: {
        state: 'PARTIAL',
        verdict: 'UNKNOWN',
        completeness: {
          badges: emptyCompleteness,
          reasons: ['MANIFEST_AND_FILE_HEURISTICS_ONLY'],
        },
        badges: [],
      },
      packages: {
        state: 'PARTIAL',
        verdict: 'UNKNOWN',
        completeness: {
          inventory: emptyCompleteness,
          directUsage: emptyCompleteness,
          dependencyGraphNodes: emptyCompleteness,
          dependencyGraphEdges: emptyCompleteness,
          reasons: ['OPTIONAL_CHECKS_INCOMPLETE'],
        },
        checks: {osv: 'NOT_CHECKED', malware: 'NOT_APPLICABLE'},
        inventory: [],
        directUsage: [],
        dependencyGraph: {
          state: 'COMPLETE', ecosystem: 'npm', lockfile: 'package-lock.json', lockfileVersion: 3, root: '(root)',
          completeness: {
            nodes: emptyCompleteness,
            edges: emptyCompleteness,
            declarations: {total: 0, resolved: 0, unresolved: 0, local: 0, optionalMissing: 0},
            reasons: [],
          },
          nodes: [],
          edges: [],
        },
      },
    },
    ...overrides,
  }
}

test('sync payload v2: exact graph-only wire shape remains unchanged', () => {
  const payload = createSyncPayload(graph({
    unknownRoot: 'must not pass',
    nodes: [{
      id: 'src/a.js#run@1',
      label: 'run()',
      file_type: 'code',
      source_file: 'src/a.js',
      source_location: 'L1',
      source_end: 'L3',
      community: 2,
      exported: true,
      decorated: false,
      source_text: 'private source',
      complexity: {startLine: 1, endLine: 3, cyclomatic: 2, source: 'private source'},
    }],
    links: [{
      source: 'src/a.js',
      target: 'src/a.js#run@1',
      relation: 'contains',
      confidence: 'EXTRACTED',
      compileOnly: true,
      line: 1,
      specifier: './a.js',
      unknown: 'must not pass',
    }],
    externalImports: [{
      file: 'src/a.js',
      spec: 'node:fs',
      target: 'C:\\private\\resolved.js',
      pkg: 'fs',
      kind: 'esm',
      ecosystem: 'npm',
      line: 1,
      builtin: true,
      dynamic: false,
      unresolved: false,
      typeOnly: true,
    }],
  }))

  assert.deepEqual(payload, {
    syncPayloadV: 2,
    repoBoundaryV: 1,
    edgeTypesV: 2,
    extImportsV: 2,
    complexityV: 1,
    nodes: [{
      id: 'src/a.js#run@1',
      label: 'run()',
      file_type: 'code',
      source_file: 'src/a.js',
      source_location: 'L1',
      source_end: 'L3',
      community: 2,
      exported: true,
      decorated: false,
      complexity: {startLine: 1, endLine: 3, cyclomatic: 2},
    }],
    links: [{
      source: 'src/a.js',
      target: 'src/a.js#run@1',
      relation: 'contains',
      confidence: 'EXTRACTED',
      compileOnly: true,
      line: 1,
      specifier: './a.js',
    }],
    externalImports: [{
      file: 'src/a.js',
      spec: 'node:fs',
      target: 'C:\\private\\resolved.js',
      pkg: 'fs',
      kind: 'esm',
      ecosystem: 'npm',
      line: 1,
      builtin: true,
      dynamic: false,
      unresolved: false,
    }],
  })
})

test('sync payload v3: exposes only the versioned graph and evidence envelope', () => {
  const payload = createSyncPayloadV3(graph(), minimalEvidence())

  assert.deepEqual(Object.keys(payload).sort(), [
    'complexityV',
    'edgeProvenanceV',
    'edgeTypesV',
    'evidence',
    'evidenceV',
    'extImportsV',
    'externalImports',
    'links',
    'nodes',
    'repoBoundaryV',
    'syncPayloadV',
  ])
  assert.equal(payload.syncPayloadV, 3)
  assert.equal(payload.evidenceV, 1)
  assert.equal(payload.evidence.evidenceSnapshotV, 1)
  assert.match(payload.evidence.snapshotHash, /^[a-f0-9]{64}$/)
  assert.notEqual(payload.evidence.snapshotHash, 'a'.repeat(64), 'wire hash covers the sanitized evidence')
  assert.deepEqual(Object.keys(payload.evidence.sections).sort(), [
    'architecture',
    'duplicates',
    'health',
    'packages',
    'technologies',
  ])
})

test('sync payload v3: allowlists edge provenance while v2 stays unchanged', () => {
  const source = graph({
    nodes: [{id: 'src/a.js', source_file: 'src/a.js'}, {id: 'src/b.js', source_file: 'src/b.js'}],
    links: [
      {source: 'src/a.js', target: 'src/b.js', relation: 'imports', provenance: 'RESOLVED', confidence: 'EXTRACTED'},
      {source: 'src/b.js', target: 'src/a.js', relation: 'calls', provenance: 'host-secret', confidence: 'INFERRED'},
    ],
  })
  assert.deepEqual(createSyncPayload(source).links, [
    {source: 'src/a.js', target: 'src/b.js', relation: 'imports', confidence: 'EXTRACTED'},
    {source: 'src/b.js', target: 'src/a.js', relation: 'calls', confidence: 'INFERRED'},
  ])
  assert.deepEqual(createSyncPayloadV3(source, minimalEvidence()).links, [
    {source: 'src/a.js', target: 'src/b.js', relation: 'imports', confidence: 'EXTRACTED', provenance: 'RESOLVED'},
    {source: 'src/b.js', target: 'src/a.js', relation: 'calls', confidence: 'INFERRED', provenance: 'INFERRED'},
  ])
})

test('sync payload v3: requires provenance metadata without changing v2 compatibility', () => {
  const legacy = graph({edgeProvenanceV: 0})
  assert.equal(createSyncPayload(legacy).syncPayloadV, 2)
  assert.throws(() => createSyncPayloadV3(legacy, minimalEvidence()), /predates edge provenance metadata/)
})

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
    state: 'COMPLETE',
    verdict: 'UNKNOWN',
    source_text: secret,
    thresholds: {clones: {mode: 'strict', minSimilarityPercent: 1, minTokens: 1}},
    completeness: {
      fragments: {total: 5000, eligible: 2000, filtered: 3000},
      cloneGroups: {total: 105, returned: 105, truncated: false},
      divergenceCandidates: {total: 105, returned: 105, truncated: false},
      reasons: [],
    },
    cloneGroups: Array.from({length: 105}, (_, index) => ({
      id: (index + 1).toString(16).padStart(24, '0'),
      memberCount: 15,
      totalTokens: 1200,
      strongestSimilarity: 100,
      weakestLinkedSimilarity: 82,
      members: Array.from({length: 15}, (_, memberIndex) => member(index, memberIndex)),
      source_text: secret,
      absolutePath: absolute,
    })),
    divergenceCandidates: Array.from({length: 105}, (_, index) => ({
      id: (index + 1000).toString(16).padStart(24, '0'),
      symbol: `computePlan${index}`,
      similarity: 20,
      totalTokens: 160,
      members: [member(index + 200, 0), member(index + 200, 1)],
      snippet: secret,
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

test('sync payload v3: normalizes repository paths and enforces node identity', () => {
  const payload = createSyncPayloadV3(graph({
    nodes: [
      {id: 'src\\a.js', source_file: 'src\\a.js'},
      {id: 'src\\a.js#run@1', source_file: 'src\\a.js'},
      {id: 'src/b.js#bad/name', source_file: 'src/b.js'},
      {id: 'src/c.js#bad name', source_file: 'src/c.js'},
      {id: 'src/d.js#run@1', source_file: 'src/not-d.js'},
      {id: 'C:\\private\\outside.js#leak@1', source_file: 'C:\\private\\outside.js'},
      {id: '../outside.js#leak@1', source_file: '../outside.js'},
    ],
    links: [{source: 'src\\a.js', target: 'src\\a.js#run@1', relation: 'contains'}],
  }), minimalEvidence())

  assert.deepEqual(payload.nodes.map(({id, source_file}) => ({id, source_file})), [
    {id: 'src/a.js', source_file: 'src/a.js'},
    {id: 'src/a.js#run@1', source_file: 'src/a.js'},
  ])
  assert.deepEqual(payload.links, [{source: 'src/a.js', target: 'src/a.js#run@1', relation: 'contains'}])
})

test('sync payload v3: rejects normalized duplicate node IDs', () => {
  assert.throws(() => createSyncPayloadV3(graph({
    nodes: [
      {id: 'src/a.js', source_file: 'src/a.js'},
      {id: 'src\\a.js', source_file: 'src\\a.js'},
    ],
  }), minimalEvidence()), /duplicate node id/)
})

test('sync payload v3: rejects links whose endpoints are not accepted nodes', () => {
  assert.throws(() => createSyncPayloadV3(graph({
    nodes: [{id: 'src/a.js', source_file: 'src/a.js'}],
    links: [{source: 'src/a.js', target: 'src/missing.js', relation: 'imports'}],
  }), minimalEvidence()), /dangling link/)
})

test('sync payload v3: strips absolute external-import targets and keeps type-only evidence', () => {
  const payload = createSyncPayloadV3(graph({
    externalImports: [{
      file: 'src\\a.js',
      spec: 'react',
      target: 'C:\\Users\\Alice\\private.js',
      pkg: 'react',
      kind: 'esm',
      typeOnly: true,
      source_text: 'private source',
    }],
  }), minimalEvidence())

  assert.deepEqual(payload.externalImports, [{
    file: 'src/a.js',
    spec: 'react',
    pkg: 'react',
    kind: 'esm',
    typeOnly: true,
  }])
})

test('sync payload v3: unknown graph and evidence fields cannot carry source or secrets', () => {
  const secret = 'PRIVATE_SOURCE_BODY_6dcf'
  const absolute = 'C:\\Users\\Alice\\.ssh\\id_rsa'
  const evidence = minimalEvidence({
    secret,
    source_text: secret,
    absolutePath: absolute,
  })
  evidence.sections.architecture.secret = secret
  evidence.sections.health.source_text = secret
  evidence.sections.packages.absolutePath = absolute

  const payload = createSyncPayloadV3(graph({
    secret,
    source_text: secret,
    absolutePath: absolute,
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

test('sync payload v3: strips embedded host paths and file URI external specifiers', () => {
  const windowsPath = 'x=C:\\Users\\Alice\\private.txt'
  const payload = createSyncPayloadV3(graph({
    nodes: [{id: 'src/a.js', source_file: 'src/a.js', label: windowsPath}],
    links: [{source: 'src/a.js', target: 'src/a.js', relation: 'imports', specifier: `pkg/${windowsPath.slice(2)}`}],
    externalImports: [
      {file: 'src/a.js', spec: 'file:///C:/Users/Alice/private.txt', pkg: 'react', ecosystem: 'npm'},
      {file: 'src/a.js', spec: 'pkg/C:/Users/Alice/private.txt', pkg: 'react', ecosystem: 'npm'},
    ],
  }), minimalEvidence())

  assert.equal(payload.nodes[0].label, undefined)
  assert.equal(payload.links[0].specifier, undefined)
  assert.deepEqual(payload.externalImports.map((item) => item.spec), [undefined, undefined])
})

test('sync payload v3: rejects oversized raw arrays before traversing them', () => {
  for (const [key, limit] of [
    ['nodes', MAX_SYNC_NODES],
    ['links', MAX_SYNC_LINKS],
    ['externalImports', MAX_SYNC_EXTERNAL_IMPORTS],
  ]) {
    const oversized = new Array(limit + 1)
    assert.throws(
      () => createSyncPayloadV3(graph({[key]: oversized}), minimalEvidence()),
      new RegExp(`${key} has ${limit + 1} entries`),
    )
  }
})
