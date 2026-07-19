// Propagate catalog.mjs's cache-busting query to owner modules so development hot reload remains
// behaviorally identical to the former single-file implementation.
const version = new URL(import.meta.url).search
const load = (path) => import(new URL(`${path}${version}`, import.meta.url).href)
const [lifecycle, advisories, architecture, sync] = await Promise.all([
  load('./actions/graph-lifecycle.mjs'),
  load('./actions/advisories.mjs'),
  load('./actions/hosted-architecture.mjs'),
  load('./actions/graph-sync.mjs'),
])

export const tOpenRepo = lifecycle.tOpenRepo
export const tListKnownRepos = lifecycle.tListKnownRepos
export const tRebuildGraph = lifecycle.tRebuildGraph
export const tRefreshAdvisories = advisories.tRefreshAdvisories
export const tPullArchitectureContract = architecture.tPullArchitectureContract
export const tPreviewSyncGraph = sync.tPreviewSyncGraph
export const tSyncGraph = sync.tSyncGraph
