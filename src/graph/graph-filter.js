// Pure graph filters applied to a built graph.json (no I/O). graph-builder itself has no test/scope
// filter, so we post-process the graph object: drop test nodes, keep only a subpath, etc.

export function isTestPath(path) {
  return /(^|[\\/])(__tests?__|tests?)([\\/]|$)|\.(test|itest|spec|e2e)\.|_test\.go$|(^|[\\/])test_[^\\/]*\.py$/i.test(String(path || ""));
}

// Filter a built graph.json by test-mode: drop test nodes ("no-tests") or keep only tests + the
// nodes they depend on ("tests-only"). graph-builder update has no test filter, so we do it post-build.
export function filterGraphForMode(graph, mode) {
  if (mode !== "no-tests" && mode !== "tests-only") return graph;
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const endpoint = (value) => (value && typeof value === "object" ? value.id : value);
  let keep;
  if (mode === "no-tests") {
    keep = new Set(nodes.filter((node) => !isTestPath(node.source_file)).map((node) => node.id));
  } else {
    const testIds = new Set(nodes.filter((node) => isTestPath(node.source_file)).map((node) => node.id));
    keep = new Set(testIds);
    for (const link of links) {
      if (testIds.has(endpoint(link.source))) keep.add(endpoint(link.target)); // a test's dependency
    }
  }
  return {
    ...graph,
    nodes: nodes.filter((node) => keep.has(node.id)),
    links: links.filter((link) => keep.has(endpoint(link.source)) && keep.has(endpoint(link.target)))
  };
}

// Keep only nodes under a subpath (path-scope), drop links touching removed nodes.
export function filterGraphByScope(graph, scope) {
  if (!scope) return graph;
  const norm = (p) => String(p || "").replace(/\\/g, "/");
  const prefix = norm(scope).replace(/\/+$/, "") + "/";
  const endpoint = (value) => (value && typeof value === "object" ? value.id : value);
  const keep = new Set((graph.nodes || []).filter((node) => (norm(node.source_file) + "/").startsWith(prefix)).map((node) => node.id));
  return {
    ...graph,
    nodes: (graph.nodes || []).filter((node) => keep.has(node.id)),
    links: (graph.links || []).filter((link) => keep.has(endpoint(link.source)) && keep.has(endpoint(link.target)))
  };
}
