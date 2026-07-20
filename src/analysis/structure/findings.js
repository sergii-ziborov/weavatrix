import {makeFinding} from '../findings.js'
import {formatRepresentativeCycle} from '../cycle-route.js'
import {
    buildFileImportGraph,
    checkBoundaries,
    findOrphans,
    findSccs,
    representativeCycle,
} from './dependency-graph.js'

const MAX_CYCLE_FINDINGS = 50
const MAX_BOUNDARY_FINDINGS = 100

const edgeCountIn = (component, edges) => {
    const inside = new Set(component)
    return edges.reduce((count, [source, target]) => count + (inside.has(source) && inside.has(target) ? 1 : 0), 0)
}

function runtimeCycleFinding(adjacency, component) {
    const cycle = representativeCycle(adjacency, component)
    const cycleRoute = formatRepresentativeCycle(cycle)
    return makeFinding({
        category: 'structure',
        rule: 'circular-dep',
        severity: component.length > 4 ? 'high' : 'medium',
        confidence: 'high',
        title: `Circular dependency: ${component.length} files`,
        detail: `${cycleRoute}${component.length + 1 > cycle.length ? ` (representative loop; the tangle spans ${component.length} files)` : ''}. Break the cycle by extracting the shared piece or inverting one import.`,
        cycleRoute,
        cycleMembers: [...component].sort(),
        file: cycle[0],
        graphNodeId: cycle[0],
        evidence: cycle.map((file) => ({file, line: 0, snippet: ''})),
        source: 'internal',
        fixHint: 'extract the shared code into a module both sides import, or invert the weaker dependency',
    })
}

function compileTimeFinding(adjacency, component, runtimeComponents, edges) {
    const cycle = representativeCycle(adjacency, component)
    const cycleRoute = formatRepresentativeCycle(cycle)
    const runtimeInside = edgeCountIn(component, edges.runtime)
    const typeInside = edgeCountIn(component, edges.typeOnly)
    const compileInside = edgeCountIn(component, edges.compileOnly)
    const containsRuntimeCycle = runtimeComponents.some((runtime) => runtime.every((file) => component.includes(file)))
    const typeSpecific = compileInside === 0
    return makeFinding({
        category: 'structure',
        rule: typeSpecific ? 'type-coupling' : 'compile-time-coupling',
        severity: 'info',
        confidence: 'high',
        title: `${containsRuntimeCycle
            ? (typeSpecific ? 'Type imports expand dependency coupling' : 'Compile-time edges expand dependency coupling')
            : (typeSpecific ? 'Type-induced dependency cycle (no runtime cycle)' : 'Compile-time dependency cycle (no runtime cycle)')}: ${component.length} files`,
        detail: `${cycleRoute}. This strongly-connected group needs compile-time-only edges to close; it contains ${runtimeInside} runtime edge(s), ${typeInside} type-only edge(s), and ${compileInside} compile-only edge(s)${containsRuntimeCycle ? ', with a smaller runtime cycle reported separately' : ', while its runtime import graph is acyclic'}. Treat this as design coupling, not an initialization-order failure.`,
        cycleRoute,
        cycleMembers: [...component].sort(),
        file: cycle[0],
        graphNodeId: cycle[0],
        evidence: cycle.map((file) => ({file, line: 0, snippet: ''})),
        source: 'internal',
        fixHint: 'review the compile-time ownership only if the coupling impedes changes; no runtime-cycle fix is required',
    })
}

// Idiomatic Rust module trees close compile-time SCCs by construction: the parent (mod.rs, lib.rs,
// main.rs, or a 2018-edition foo.rs) declares `mod child` while children reach back via super::/crate::.
// Suppress only when every member is a .rs file sitting under one anchor's directory; genuine
// cross-directory .rs cycles keep their findings.
function isRustModuleTreeComponent(component) {
    if (!component.every((file) => String(file).endsWith('.rs'))) return false
    return component.some((anchor) => {
        const path = String(anchor)
        const slash = path.lastIndexOf('/')
        const base = path.slice(slash + 1)
        const anchorDir = ['mod.rs', 'lib.rs', 'main.rs'].includes(base)
            ? (slash >= 0 ? path.slice(0, slash) : '')
            : path.slice(0, -'.rs'.length)
        return anchorDir !== '' && component.every((member) => member === anchor || String(member).startsWith(`${anchorDir}/`))
    })
}

export function computeStructureFindings(graph, {rules = {}, entrySet = new Set(), externalImportFiles = new Set()} = {}) {
    const imports = buildFileImportGraph(graph)
    const findings = []
    const runtimeComponents = findSccs(imports.adj).sort((a, b) => b.length - a.length)
    for (const component of runtimeComponents.slice(0, MAX_CYCLE_FINDINGS)) {
        findings.push(runtimeCycleFinding(imports.adj, component))
    }

    const runtimeKeys = new Set(runtimeComponents.map((component) => [...component].sort().join('\0')))
    const allComponents = findSccs(imports.allAdj).sort((a, b) => b.length - a.length)
    const compileTimeCandidates = allComponents.filter((component) => !runtimeKeys.has([...component].sort().join('\0')))
    const rustModuleTreeComponents = compileTimeCandidates.filter((component) => isRustModuleTreeComponent(component))
    const compileTimeCouplings = compileTimeCandidates.filter((component) => !isRustModuleTreeComponent(component))
    for (const component of compileTimeCouplings.slice(0, MAX_CYCLE_FINDINGS)) {
        findings.push(compileTimeFinding(imports.allAdj, component, runtimeComponents, {
            runtime: imports.edges,
            typeOnly: imports.typeOnlyEdges,
            compileOnly: imports.compileOnlyEdges,
        }))
    }
    if (runtimeComponents.length > MAX_CYCLE_FINDINGS) findings.push(makeFinding({
        category: 'structure', rule: 'circular-dep', severity: 'info', confidence: 'high',
        title: `…and ${runtimeComponents.length - MAX_CYCLE_FINDINGS} more dependency cycles`,
        detail: `Cycle findings are capped at ${MAX_CYCLE_FINDINGS}; ${runtimeComponents.length} strongly-connected groups exist in total.`,
        source: 'internal',
    }))

    for (const orphan of findOrphans(graph, {entrySet, externalImportFiles})) findings.push(makeFinding({
        category: 'structure',
        rule: 'orphan-file',
        severity: 'info',
        confidence: orphan.importsExternals ? 'low' : 'medium',
        title: `Orphan file: ${orphan.file}`,
        detail: `No repo file imports it and it imports/calls nothing in the repo${orphan.importsExternals ? ' (it does use npm packages — possibly a standalone script or tool)' : ''}. Possibly dead, possibly an undeclared entry point.`,
        file: orphan.file,
        graphNodeId: orphan.file,
        source: 'internal',
    }))

    const violations = checkBoundaries(imports.edges, rules)
    for (const item of violations.slice(0, MAX_BOUNDARY_FINDINGS)) findings.push(makeFinding({
        category: 'structure',
        rule: 'boundary-violation',
        severity: ['critical', 'high', 'medium', 'low', 'info'].includes(item.severity) ? item.severity : 'medium',
        confidence: 'high',
        title: `Boundary violation (${item.name}): ${item.from} → ${item.to}`,
        detail: `${item.kind === 'allowedOnly' ? 'Import leaves the allowed set' : 'Forbidden import'}${item.comment ? `: ${item.comment}` : ''}.`,
        file: item.from,
        graphNodeId: item.from,
        evidence: [{file: item.from, line: 0, snippet: `imports ${item.to}`}],
        source: 'internal',
    }))
    if (violations.length > MAX_BOUNDARY_FINDINGS) findings.push(makeFinding({
        category: 'structure', rule: 'boundary-violation', severity: 'info', confidence: 'high',
        title: `…and ${violations.length - MAX_BOUNDARY_FINDINGS} more boundary violations`,
        detail: `Boundary findings are capped at ${MAX_BOUNDARY_FINDINGS}; ${violations.length} edges violate the rules in total.`,
        source: 'internal',
    }))

    return {
        findings,
        stats: {
            importEdges: imports.allEdges.length,
            runtimeImportEdges: imports.edges.length,
            typeOnlyImportEdges: imports.typeOnlyEdges.length,
            compileOnlyImportEdges: imports.compileOnlyEdges.length,
            compileTimeImportEdges: imports.compileTimeEdges.length,
            cycles: runtimeComponents.length,
            runtimeCycles: runtimeComponents.length,
            largestCycle: runtimeComponents[0]?.length || 0,
            typeCouplings: compileTimeCouplings.length,
            largestTypeCoupling: compileTimeCouplings[0]?.length || 0,
            compileTimeCouplings: compileTimeCouplings.length,
            largestCompileTimeCoupling: compileTimeCouplings[0]?.length || 0,
            rustModuleTreeCouplings: rustModuleTreeComponents.length,
            orphans: findings.filter((finding) => finding.rule === 'orphan-file').length,
            boundaryViolations: violations.length,
        },
    }
}
