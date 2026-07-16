import {
    CAPS, STATE, VERDICT, bounded, compareText, moduleId, nonNegativeInteger,
} from './evidence-snapshot.common.mjs'

function sanitizeModule(value) {
    const id = moduleId(value?.name)
    if (!id) return null
    return {
        id,
        fileCount: nonNegativeInteger(value.fileCount),
        nodeCount: nonNegativeInteger(value.nodeCount),
        symbolCount: nonNegativeInteger(value.symbolCount),
    }
}

function sanitizeModuleDependency(value) {
    const from = moduleId(value?.from)
    const to = moduleId(value?.to)
    if (!from || !to || from === to) return null
    return {from, to, count: nonNegativeInteger(value.count)}
}

function sortedModuleDependencies(values) {
    return (Array.isArray(values) ? values : [])
        .map(sanitizeModuleDependency)
        .filter(Boolean)
        .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || a.count - b.count)
}

export function buildArchitectureSection(graph, aggregate, audit, structure) {
    if (!aggregate) {
        return {
            state: STATE.ERROR,
            verdict: VERDICT.UNKNOWN,
            completeness: {reasons: ['GRAPH_AGGREGATION_ERROR']},
            modules: [],
            dependencies: {runtime: [], typeOnly: [], compileOnly: []},
            cycles: [],
            boundaryViolations: [],
        }
    }

    const modules = bounded(
        (aggregate.modules || []).map(sanitizeModule).filter(Boolean).sort((a, b) => compareText(a.id, b.id)),
        CAPS.modules,
    )
    const runtime = bounded(sortedModuleDependencies(aggregate.moduleEdges), CAPS.moduleDependencies)
    const typeOnly = bounded(sortedModuleDependencies(aggregate.typeOnlyModuleEdges), CAPS.moduleDependencies)
    const compileOnly = bounded(sortedModuleDependencies(aggregate.compileOnlyModuleEdges), CAPS.moduleDependencies)
    const cycles = structure?.cycles || bounded([], CAPS.architectureFindings)
    const boundaries = structure?.boundaries || bounded([], CAPS.architectureFindings)

    const edgeTypesComplete = Number.isInteger(graph?.edgeTypesV) && graph.edgeTypesV >= 2
    const auditComplete = audit?.ok === true
    const structureComplete = structure?.state === STATE.COMPLETE
    const state = edgeTypesComplete && auditComplete && structureComplete ? STATE.COMPLETE : STATE.PARTIAL
    const fails = cycles.items.some((cycle) => cycle.kind === 'runtime') || boundaries.items.length > 0
    return {
        state,
        verdict: fails ? VERDICT.FAIL : state === STATE.COMPLETE ? VERDICT.PASS : VERDICT.UNKNOWN,
        completeness: {
            modules: modules.completeness,
            runtimeDependencies: runtime.completeness,
            typeOnlyDependencies: typeOnly.completeness,
            compileOnlyDependencies: compileOnly.completeness,
            cycles: cycles.completeness,
            boundaryViolations: boundaries.completeness,
            reasons: [
                ...(!edgeTypesComplete ? ['EDGE_TYPES_V2_REQUIRED'] : []),
                ...(!auditComplete ? ['AUDIT_UNAVAILABLE'] : []),
                ...(!structureComplete ? ['STRUCTURE_EVIDENCE_UNAVAILABLE'] : []),
            ],
        },
        modules: modules.items,
        dependencies: {runtime: runtime.items, typeOnly: typeOnly.items, compileOnly: compileOnly.items},
        cycles: cycles.items,
        boundaryViolations: boundaries.items,
        boundaryRulesState: structure?.rulesState || STATE.ERROR,
    }
}
