// Bounded, deterministic and source-free evidence derived locally from a repository and its graph.
// The sync wire layer applies a second allowlist because cached graph/evidence data is untrusted.
import {aggregateGraph} from '../analysis/graph-analysis.js'
import {runInternalAudit} from '../analysis/internal-audit.js'
import {detectRepoStack} from '../scan/discover.js'
import {collectInstalled} from '../security/installed.js'
import {STATE, hashSnapshot} from './evidence-snapshot.common.mjs'
import {buildArchitectureSection} from './evidence-snapshot.architecture.mjs'
import {buildDuplicatesSection} from './evidence-snapshot.duplicates.mjs'
import {buildHealthSection} from './evidence-snapshot.health.mjs'
import {buildPackagesSection, buildTechnologiesSection} from './evidence-snapshot.inventory.mjs'
import {buildStructureEvidence} from './evidence-snapshot.structure.mjs'

export async function createEvidenceSnapshot({repoRoot, graph}) {
    const inputGraph = graph && typeof graph === 'object' && !Array.isArray(graph)
        ? graph
        : {nodes: [], links: [], externalImports: []}

    let aggregate = null
    try { aggregate = aggregateGraph(inputGraph) } catch { aggregate = null }

    let audit = null
    try { audit = await runInternalAudit(repoRoot, {graph: inputGraph, skipMalwareScan: true}) } catch { audit = null }

    let stack = null
    let stackError = false
    try { stack = detectRepoStack(repoRoot) } catch { stackError = true }

    let installedResult = null
    let installedError = false
    try { installedResult = collectInstalled(repoRoot) } catch { installedError = true }

    const structure = buildStructureEvidence(inputGraph, repoRoot)

    const sections = {
        architecture: buildArchitectureSection(inputGraph, aggregate, audit, structure),
        duplicates: buildDuplicatesSection(repoRoot, inputGraph),
        health: buildHealthSection(inputGraph, audit),
        technologies: buildTechnologiesSection(stack, stackError),
        packages: buildPackagesSection(installedResult, installedError, inputGraph, audit, repoRoot),
    }
    const sectionStates = Object.values(sections).map((section) => section.state)
    const state = sectionStates.every((value) => value === STATE.ERROR)
        ? STATE.ERROR
        : sectionStates.every((value) => value === STATE.COMPLETE || value === STATE.NOT_APPLICABLE)
            ? STATE.COMPLETE
            : STATE.PARTIAL
    const snapshot = {evidenceSnapshotV: 1, state, sections}
    return {...snapshot, snapshotHash: hashSnapshot(snapshot)}
}
