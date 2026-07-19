// Propagate catalog.mjs's cache-busting query to owner modules so development hot reload remains
// behaviorally identical to the former single-file implementation.
const version = new URL(import.meta.url).search
const load = (path) => import(new URL(`${path}${version}`, import.meta.url).href)
const [lifecycle] = await Promise.all([
  load('./actions/graph-lifecycle.mjs'),
])

export const tOpenRepo = lifecycle.tOpenRepo
export const tListKnownRepos = lifecycle.tListKnownRepos
export const tRebuildGraph = lifecycle.tRebuildGraph
