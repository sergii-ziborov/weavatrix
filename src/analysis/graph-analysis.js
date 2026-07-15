// Reading a built graph.json and aggregating it into the views the UI needs: named communities,
// degree hotspots, and the file/module/symbol rollup. `aggregateGraph` is pure (covered by tests);
// the rest read the graph file from disk.
// Facade: implementation lives in graph-analysis.summaries.js and graph-analysis.aggregate.js
// (with internal helpers in graph-analysis.refs.js).
export { summarizeCommunities, summarizeHotspots } from "./graph-analysis.summaries.js";
export { analyzeGraph, aggregateGraph } from "./graph-analysis.aggregate.js";
