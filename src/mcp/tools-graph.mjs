// Stable public facade for graph inspection and traversal tools. Propagate the catalog's
// cache-busting query into owner modules so edits go live without an MCP reconnect.
const version = new URL(import.meta.url).search
const load = (path) => import(new URL(`${path}${version}`, import.meta.url).href)
const [core, query, hubs] = await Promise.all([
    load('./graph/tools-core.mjs'),
    load('./graph/tools-query.mjs'),
    load('./tools-graph-hubs.mjs'),
])

export const tGraphStats = core.tGraphStats
export const tGetNode = core.tGetNode
export const tGetNeighbors = core.tGetNeighbors
export const tGetCommunity = core.tGetCommunity
export const tQueryGraph = query.tQueryGraph
export const tShortestPath = query.tShortestPath
export const tGodNodes = hubs.tGodNodes
