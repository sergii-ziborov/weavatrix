import {typeScriptLspContract} from '../typescript-lsp-provider.js'

export const PRECISION_OVERLAY_V = 4
export const PRECISION_FILE = 'precision.json'
export const JS_TS_FILE = /\.(?:[cm]?[jt]sx?)$/i
export const endpoint = (value) => String(value && typeof value === 'object' ? value.id : value)
export const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
export const graphMode = (graph) => ['full', 'no-tests', 'tests-only'].includes(graph?.graphBuildMode)
  ? graph.graphBuildMode : 'full'
export const graphScope = (graph) => String(graph?.graphBuildScope || '')
export const precisionMode = (graph) => graph?.graphPrecisionMode === 'off' ? 'off' : 'lsp'
export const providerContractFor = (graph) => precisionMode(graph) === 'off' ? 'off' : typeScriptLspContract()
export const graphContractFor = (graph) => ({
  extractorSchemaV: Number(graph?.extractorSchemaV) || 0,
  ...(graph?.repositoryFreshnessBuilderVersion != null
    ? {repositoryFreshnessBuilderVersion: String(graph.repositoryFreshnessBuilderVersion)} : {}),
  ...(graph?.graphBuilderVersion != null ? {graphBuilderVersion: String(graph.graphBuilderVersion)} : {}),
  ...(graph?.internalBuilderVersion != null ? {internalBuilderVersion: String(graph.internalBuilderVersion)} : {}),
})

function sameRequest(actual, expected) {
  if (!expected) return true
  return Number(actual?.maxSymbols) === Number(expected.maxSymbols)
    && Number(actual?.maxReferences) === Number(expected.maxReferences)
    && Number(actual?.maxLinks) === Number(expected.maxLinks)
}

export function precisionOverlayMatches(overlay, graph, {request} = {}) {
  const actualContract = overlay?.graphContract
  return Number(overlay?.precisionOverlayV) === PRECISION_OVERLAY_V
    && String(overlay?.baseGraphRevision || '') === String(graph?.graphRevision || '')
    && String(overlay?.graphBuildMode || 'full') === graphMode(graph)
    && String(overlay?.graphBuildScope || '') === graphScope(graph)
    && String(overlay?.precisionMode || '') === precisionMode(graph)
    && String(overlay?.providerContract || '') === providerContractFor(graph)
    && actualContract != null && typeof actualContract === 'object'
    && JSON.stringify(actualContract) === JSON.stringify(graphContractFor(graph))
    && sameRequest(overlay?.request, request)
}

export function baseOverlay(graph, state, extra = {}) {
  return {
    precisionOverlayV: PRECISION_OVERLAY_V,
    baseGraphRevision: String(graph.graphRevision || ''),
    graphBuildMode: graphMode(graph),
    graphBuildScope: graphScope(graph),
    precisionMode: precisionMode(graph),
    providerContract: providerContractFor(graph),
    graphContract: graphContractFor(graph),
    state,
    engines: [],
    coverage: {
      candidates: 0, selected: 0, queried: 0, references: 0,
      unclassifiedReferences: 0, verifiedEdges: 0, truncated: false,
    },
    links: [],
    referenceEvidence: [],
    noReferenceSymbols: [],
    ...extra,
  }
}
