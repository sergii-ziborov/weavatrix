// Stable facade for structural dependency analysis.
export {
    buildFileImportGraph,
    checkBoundaries,
    findOrphans,
    findSccs,
    globToRe,
    representativeCycle,
} from './structure/dependency-graph.js'
export {computeStructureFindings} from './structure/findings.js'
