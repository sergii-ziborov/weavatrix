// Graph filters applied to a built graph.json. Test semantics come from the shared repository path
// classifier, so no-tests agrees with duplicate/audit/coverage tools (including repo config).
import { createPathClassifier, hasPathClass } from "../path-classification.js";

export function isTestPath(path) {
  return hasPathClass(createPathClassifier(null).explain(path), "test", "e2e");
}

const normalizedPath = (value) => String(value || "").replace(/\\/g, "/");

function externalImportsForNodes(graph, nodes) {
  if (!Array.isArray(graph.externalImports)) return undefined;
  const files = new Set(nodes.map((node) => normalizedPath(node.source_file)).filter(Boolean));
  return graph.externalImports.filter((item) => files.has(normalizedPath(item?.file)));
}

// Filter a built graph.json by test-mode: drop test nodes ("no-tests") or keep only tests + the
// nodes they depend on ("tests-only"). graph-builder update has no test filter, so we do it post-build.
export function filterGraphForMode(graph, mode, { repoRoot = null } = {}) {
  if (mode !== "no-tests" && mode !== "tests-only") return graph;
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const endpoint = (value) => (value && typeof value === "object" ? value.id : value);
  const classifier = createPathClassifier(repoRoot);
  // A node is a test surface when its file is test-classified OR the extractor proved the symbol
  // itself is compiled only under test (Rust #[cfg(test)] inline modules live in production files).
  const isTest = (node) => node.test_surface === true || hasPathClass(classifier.explain(node.source_file), "test", "e2e");
  let keep;
  if (mode === "no-tests") {
    keep = new Set(nodes.filter((node) => !isTest(node)).map((node) => node.id));
  } else {
    const testIds = new Set(nodes.filter((node) => isTest(node)).map((node) => node.id));
    keep = new Set(testIds);
    for (const link of links) {
      if (testIds.has(endpoint(link.source))) keep.add(endpoint(link.target)); // a test's dependency
    }
  }
  const keptNodes = nodes.filter((node) => keep.has(node.id));
  const externalImports = externalImportsForNodes(graph, keptNodes);
  return {
    ...graph,
    nodes: keptNodes,
    links: links.filter((link) => keep.has(endpoint(link.source)) && keep.has(endpoint(link.target))),
    ...(externalImports ? { externalImports } : {})
  };
}

// Keep only nodes under a subpath (path-scope), drop links touching removed nodes.
export function filterGraphByScope(graph, scope) {
  if (!scope) return graph;
  const norm = normalizedPath;
  const prefix = norm(scope).replace(/\/+$/, "") + "/";
  const endpoint = (value) => (value && typeof value === "object" ? value.id : value);
  const keep = new Set((graph.nodes || []).filter((node) => (norm(node.source_file) + "/").startsWith(prefix)).map((node) => node.id));
  const keptNodes = (graph.nodes || []).filter((node) => keep.has(node.id));
  const externalImports = externalImportsForNodes(graph, keptNodes);
  return {
    ...graph,
    nodes: keptNodes,
    links: (graph.links || []).filter((link) => keep.has(endpoint(link.source)) && keep.has(endpoint(link.target))),
    ...(externalImports ? { externalImports } : {})
  };
}
