// A deliberately weaker fallback than real coverage: follow runtime graph edges out of test files
// and report nearest test paths. This is evidence of static reachability only; it never claims a line,
// branch or symbol executed. The traversal is bounded for large repositories.
import { createPathClassifier, hasPathClass } from "../path-classification.js";
import { isStructuralRelation } from "../graph/relations.js";

const MAX_TEST_FILES = 250;
const MAX_NEAREST_TESTS = 3;
const MAX_DEPTH = 10;
const MAX_STATES = 100_000;

const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const endpoint = (value) => String(value && typeof value === "object" ? value.id : value || "");
const confidenceScore = (value) => {
  const normalized = String(value || "").toUpperCase();
  if (["EXTRACTED", "EXACT", "HIGH"].includes(normalized)) return 3;
  if (["INFERRED", "MEDIUM"].includes(normalized)) return 2;
  return 1;
};
const confidenceLabel = (score) => score >= 3 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
const pathInScope = (path, prefix) => !prefix || path === prefix || path.startsWith(`${prefix}/`);

export function computeStaticTestReachability(graph, {
  repoRoot = null,
  path = "",
  maxDepth = MAX_DEPTH,
  maxStates = MAX_STATES,
  maxTests = MAX_TEST_FILES,
  maxNearestTests = MAX_NEAREST_TESTS,
} = {}) {
  const nodes = graph?.nodes || [];
  const links = graph?.links || [];
  const classifier = createPathClassifier(repoRoot);
  const classificationCache = new Map();
  const classify = (file) => {
    const normalized = normalize(file);
    if (!classificationCache.has(normalized)) classificationCache.set(normalized, classifier.explain(normalized, { content: "" }));
    return classificationCache.get(normalized);
  };
  // Files that carry inline test surfaces (Rust `#[cfg(test)]` modules / `#[test]` fns live inside the
  // production file, so path classification alone never sees them). The graph flags these per symbol.
  // These files are NOT seeded as whole-file BFS sources: at file granularity we cannot tell an inline
  // test's out-edge from a same-file production call, so seeding the file would propagate its PRODUCTION
  // call chains as if a test reached them. They are self-covered at distance 0 instead (an honest,
  // conservative signal: "this file has its own tests"), never over-claiming reach to other files.
  const testSurfaceFiles = new Set();
  const isTest = (file) => hasPathClass(classify(file), "test", "e2e");
  const isProduct = (file) => {
    const info = classify(file);
    return !info.excluded && !hasPathClass(info, "test", "e2e", "generated", "vendored", "mock", "story", "docs", "benchmark", "temp");
  };

  const idToFile = new Map();
  const files = new Set();
  for (const node of nodes) {
    const file = normalize(node?.source_file || (!String(node?.id || "").includes("#") ? node?.id : ""));
    if (!file) continue;
    idToFile.set(String(node.id), file);
    files.add(file);
    if (node?.test_surface === true) testSurfaceFiles.add(file);
  }

  // Collapse symbol/file edges to directed file dependencies. Multiple symbol edges retain the best
  // confidence for the same hop; compile-time-only and ownership relations never imply test reach.
  const adjacency = new Map();
  for (const link of links) {
    if (!link || link.typeOnly === true || link.compileOnly === true || isStructuralRelation(link.relation)) continue;
    const from = idToFile.get(endpoint(link.source));
    const to = idToFile.get(endpoint(link.target));
    if (!from || !to || from === to) continue;
    if (!adjacency.has(from)) adjacency.set(from, new Map());
    const score = confidenceScore(link.confidence);
    const previous = adjacency.get(from).get(to);
    if (!previous || score > previous.score) adjacency.get(from).set(to, { score, relation: link.relation || "dependency" });
  }

  const allTests = [...files].filter(isTest).sort((a, b) => a.localeCompare(b));
  const testLimit = Math.max(0, Math.min(MAX_TEST_FILES, Number(maxTests) || MAX_TEST_FILES));
  const tests = allTests.slice(0, testLimit);
  const scope = normalize(path).replace(/\/+$/, "");
  const productFiles = [...files].filter(isProduct).filter((file) => pathInScope(file, scope)).sort((a, b) => a.localeCompare(b));
  const productSet = new Set(productFiles);
  const nearest = new Map();
  // A production file that carries its own inline tests is self-covered at distance 0: its tests exercise
  // its own production symbols. This is the honest floor that fixes a false "0 reachable" for repos whose
  // tests are all inline (Rust); it never asserts reach to OTHER files, so it cannot over-claim.
  const inlineCovered = productFiles.filter((file) => testSurfaceFiles.has(file));
  for (const file of inlineCovered) {
    nearest.set(file, [{ test: file, distance: 0, score: 3, confidence: confidenceLabel(3), path: [file] }]);
  }
  const queue = tests.map((test) => ({ file: test, test, distance: 0, score: 3, path: [test] }));
  const seen = new Map(tests.map((test) => [`${test}\0${test}`, 0]));
  let cursor = 0;
  let traversedStates = 0;
  const depthLimit = Math.max(1, Math.min(MAX_DEPTH, Number(maxDepth) || MAX_DEPTH));
  const stateLimit = Math.max(100, Math.min(MAX_STATES, Number(maxStates) || MAX_STATES));
  const nearestLimit = Math.max(1, Math.min(MAX_NEAREST_TESTS, Number(maxNearestTests) || MAX_NEAREST_TESTS));

  while (cursor < queue.length && traversedStates < stateLimit) {
    const current = queue[cursor++];
    traversedStates++;
    if (current.distance >= depthLimit) continue;
    for (const [next, edge] of adjacency.get(current.file) || []) {
      const distance = current.distance + 1;
      const score = Math.min(current.score, edge.score);
      const key = `${current.test}\0${next}`;
      if ((seen.get(key) ?? Infinity) <= distance) continue;
      seen.set(key, distance);
      const record = { test: current.test, distance, score, confidence: confidenceLabel(score), path: [...current.path, next] };
      if (productSet.has(next)) {
        const records = nearest.get(next) || [];
        records.push(record);
        records.sort((a, b) => a.distance - b.distance || b.score - a.score || a.test.localeCompare(b.test));
        if (records.length > nearestLimit) records.length = nearestLimit;
        nearest.set(next, records);
      }
      // Once enough nearer test paths meet at the same file, a longer test prefix cannot become a
      // nearest path downstream because every continuation from this point is shared.
      const records = nearest.get(next);
      if (records?.length >= nearestLimit && !records.some((item) => item.test === current.test) && distance > records[records.length - 1].distance) continue;
      queue.push({ file: next, test: current.test, distance, score, path: record.path });
    }
  }

  const reachable = productFiles
    .filter((file) => nearest.has(file))
    .map((file) => ({ file, nearestTests: nearest.get(file) }))
    .sort((a, b) => a.nearestTests[0].distance - b.nearestTests[0].distance || a.file.localeCompare(b.file));
  const unreachable = productFiles.filter((file) => !nearest.has(file));
  return {
    kind: "staticTestReachability",
    actualCoverage: "NOT_AVAILABLE",
    // Inline-test files self-cover rather than seed the traversal, but they ARE test-bearing files, so
    // the reported counts include them — otherwise a Rust repo would read "0 test files" beside real reach.
    testFiles: tests.length + inlineCovered.length,
    totalTestFiles: allTests.length + inlineCovered.length,
    productFiles: productFiles.length,
    reachableFiles: reachable.length,
    unreachableFiles: unreachable.length,
    reachable,
    unreachable,
    bounds: {
      maxDepth: depthLimit,
      maxStates: stateLimit,
      traversedStates,
      maxTests: testLimit,
      truncated: allTests.length > tests.length || (cursor < queue.length && traversedStates >= stateLimit),
    },
  };
}
