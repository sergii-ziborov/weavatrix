export function graph(overrides = {}) {
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

export function minimalEvidence(overrides = {}) {
  const emptyCompleteness = {total: 0, returned: 0, truncated: false}
  return {
    evidenceSnapshotV: 1,
    state: 'PARTIAL',
    snapshotHash: 'a'.repeat(64),
    sections: {
      architecture: {
        state: 'COMPLETE', verdict: 'PASS',
        completeness: {
          modules: emptyCompleteness, runtimeDependencies: emptyCompleteness,
          typeOnlyDependencies: emptyCompleteness, compileOnlyDependencies: emptyCompleteness,
          cycles: emptyCompleteness, boundaryViolations: emptyCompleteness, reasons: [],
        },
        modules: [], dependencies: {runtime: [], typeOnly: [], compileOnly: []},
        cycles: [], boundaryViolations: [],
      },
      duplicates: {
        state: 'COMPLETE', verdict: 'UNKNOWN',
        thresholds: {
          clones: {mode: 'renamed', minSimilarityPercent: 80, minTokens: 50},
          divergence: {sameName: true, maxSimilarityPercent: 45, minTokens: 50, maxImplementationsPerName: 12},
        },
        completeness: {
          fragments: {total: 0, eligible: 0, filtered: 0},
          cloneGroups: emptyCompleteness, divergenceCandidates: emptyCompleteness, reasons: [],
        },
        cloneGroups: [], divergenceCandidates: [],
      },
      health: {
        state: 'PARTIAL', verdict: 'UNKNOWN',
        completeness: {findings: emptyCompleteness, hotspots: emptyCompleteness, complexity: {analyzed: 0}, reasons: ['OPTIONAL_CHECKS_INCOMPLETE']},
        summary: {bySeverity: {}, byCategory: {}, dead: {}, structure: {}},
        checks: {osv: 'NOT_CHECKED', malware: 'NOT_APPLICABLE'}, findings: [],
        complexity: {
          thresholds: {
            loc: {warning: 120, high: 300},
            cyclomatic: {warning: 15, high: 30},
            params: {warning: 6, high: 10},
          },
          analyzed: 0, hotspots: [],
        },
      },
      technologies: {
        state: 'PARTIAL', verdict: 'UNKNOWN',
        completeness: {badges: emptyCompleteness, reasons: ['MANIFEST_AND_FILE_HEURISTICS_ONLY']},
        badges: [],
      },
      packages: {
        state: 'PARTIAL', verdict: 'UNKNOWN',
        completeness: {
          inventory: emptyCompleteness, directUsage: emptyCompleteness,
          dependencyGraphNodes: emptyCompleteness, dependencyGraphEdges: emptyCompleteness,
          reasons: ['OPTIONAL_CHECKS_INCOMPLETE'],
        },
        checks: {osv: 'NOT_CHECKED', malware: 'NOT_APPLICABLE'}, inventory: [], directUsage: [],
        dependencyGraph: {
          state: 'COMPLETE', ecosystem: 'npm', lockfile: 'package-lock.json', lockfileVersion: 3, root: '(root)',
          completeness: {
            nodes: emptyCompleteness, edges: emptyCompleteness,
            declarations: {total: 0, resolved: 0, unresolved: 0, local: 0, optionalMissing: 0},
            reasons: [],
          },
          nodes: [], edges: [],
        },
      },
    },
    ...overrides,
  }
}
