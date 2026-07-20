// Conservative, source-free review queue for statically unreferenced code. This deliberately builds
// on computeDead instead of inventing a second liveness model. Candidates are evidence for review,
// never deletion instructions: framework entry, dynamic loading, reflection and public API surfaces
// lower confidence and remain explicit in the returned record. Per-candidate record shapes live in
// dead-code-review/candidates.js; this module owns collection, filtering and the summary envelope.
import { computeDead } from "./dead-check.js";
import { createPathClassifier } from "../path-classification.js";
import {
  DEAD_CODE_CONFIDENCE_RANK as CONFIDENCE_RANK, hasDynamicCode,
  REFLECTION_CODE_RE as REFLECTION_RE, deadCodePathAllowed as pathAllowed,
  normalizedReviewPath as normalizedPath,
} from './dead-code-review/policy.js'
import { symbolCandidate, fileCandidate } from './dead-code-review/candidates.js'

// Pure review model. Filesystem collection/entry inference stays in the MCP adapter so tests can pass
// exact source maps and convention evidence without touching the working tree.
export function computeDeadCodeReview(graph, sources, options = {}) {
  const entrySet = options.entrySet instanceof Set ? options.entrySet : new Set(options.entrySet || []);
  const dynamicTargets = options.dynamicTargets instanceof Set ? options.dynamicTargets : new Set(options.dynamicTargets || []);
  const frameworkByFile = new Map((options.frameworkEvidence || []).map((entry) => [normalizedPath(entry.file), entry]));
  const classifier = options.pathClassifier || createPathClassifier(null);
  const classificationCache = new Map();
  const classify = (file, source) => {
    if (!classificationCache.has(file)) classificationCache.set(file, classifier.explain(file, { content: source }));
    return classificationCache.get(file);
  };
  const repoSignals = {
    dynamicLoading: (graph.externalImports || []).some((entry) => entry?.dynamic) || [...sources].some(([file, text]) => hasDynamicCode(text, file)),
    reflection: [...sources.values()].some((text) => REFLECTION_RE.test(String(text || ""))),
  };
  const includeTests = options.includeTests === true;
  const includeClassified = options.includeClassified === true;
  const minConfidence = Object.hasOwn(CONFIDENCE_RANK, options.minConfidence) ? options.minConfidence : "medium";
  const pathPrefix = normalizedPath(options.path || "").replace(/\/+$/, "");
  const requestedKinds = new Set(Array.isArray(options.kinds) && options.kinds.length ? options.kinds : ["file", "function", "method", "symbol"]);
  const exactNoReferenceIds = new Set(graph.precisionNoReferenceSymbols || options.exactNoReferenceIds || []);
  const context = { sources, entrySet, dynamicTargets, frameworkByFile, classify, repoSignals, exactNoReferenceIds };
  const dead = computeDead(graph, sources, { entrySet });
  const nodesById = new Map((graph.nodes || []).map((node) => [String(node.id), node]));
  const rawSymbols = [...dead.deadSymbols, ...(dead.testOnlySymbols || []).map((item) => ({...item, testOnly: true}))]
    .map((item) => ({ item, node: nodesById.get(String(item.id)) }))
    .filter((entry) => entry.node)
    .map(({ item, node }) => symbolCandidate(item, node, context));
  const symbolsByFile = new Map();
  for (const candidate of rawSymbols) {
    if (!symbolsByFile.has(candidate.file)) symbolsByFile.set(candidate.file, []);
    symbolsByFile.get(candidate.file).push(candidate);
  }
  const rawFiles = dead.deadFiles.map((item) => fileCandidate(item, symbolsByFile.get(normalizedPath(item.file)) || [], context));
  const raw = [...rawSymbols, ...rawFiles];
  const suppressed = { tests: 0, classified: 0, confidence: 0, path: 0, kind: 0 };
  const candidates = [];
  for (const candidate of raw) {
    // Node-level test surfaces (Rust #[cfg(test)] symbols in production files) follow the same
    // include_tests policy as path-classified test files.
    if (!includeTests && nodesById.get(String(candidate.id))?.test_surface === true) { suppressed.tests += 1; continue; }
    const info = classify(candidate.file, sources.get(candidate.file));
    const allowed = pathAllowed(info, { includeTests, includeClassified });
    if (!allowed.ok) { suppressed[allowed.bucket] += 1; continue; }
    if (pathPrefix && candidate.file !== pathPrefix && !candidate.file.startsWith(`${pathPrefix}/`)) { suppressed.path += 1; continue; }
    if (!requestedKinds.has(candidate.kind)) { suppressed.kind += 1; continue; }
    if (CONFIDENCE_RANK[candidate.confidence] > CONFIDENCE_RANK[minConfidence]) { suppressed.confidence += 1; continue; }
    candidates.push(candidate);
  }
  candidates.sort((left, right) =>
    CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence]
    || left.file.localeCompare(right.file)
    || left.line - right.line
    || left.id.localeCompare(right.id));

  const warnings = [{
    code: "STATIC_LIVENESS_IS_NOT_RUNTIME_PROOF",
    message: "No static reference is not proof of dead runtime code. Review every candidate; never bulk-delete or auto-delete.",
  }];
  if (repoSignals.dynamicLoading) warnings.push({
    code: "DYNAMIC_LOADING_PRESENT",
    message: "Dynamic loading exists in the repository; static callers may be incomplete.",
  });
  if (repoSignals.reflection) warnings.push({
    code: "REFLECTION_PRESENT",
    message: "Reflection-like APIs exist in the repository; public or name-addressed symbols may be invoked without graph edges.",
  });
  if (suppressed.confidence) warnings.push({
    code: "LOW_CONFIDENCE_SUPPRESSED",
    message: `${suppressed.confidence} low-confidence candidate(s), including public/framework-sensitive code, were suppressed; set min_confidence=low to review them explicitly.`,
  });

  return {
    candidates,
    warnings,
    suppressed,
    repoSignals,
    totals: {
      indexedSymbols: dead.stats.symbols,
      indexedFiles: dead.stats.files,
      rawDeadSymbols: rawSymbols.length,
      rawTestOnlySymbols: (dead.testOnlySymbols || []).length,
      rawDeadFiles: rawFiles.length,
      reviewCandidates: candidates.length,
      byConfidence: {
        high: candidates.filter((candidate) => candidate.confidence === "high").length,
        medium: candidates.filter((candidate) => candidate.confidence === "medium").length,
        low: candidates.filter((candidate) => candidate.confidence === "low").length,
      },
      byEvidenceTier: {
        strongStatic: candidates.filter((candidate) => candidate.evidenceTier === "STRONG_STATIC_EVIDENCE").length,
        boundedStatic: candidates.filter((candidate) => candidate.evidenceTier === "BOUNDED_STATIC_EVIDENCE").length,
        highUncertainty: candidates.filter((candidate) => candidate.evidenceTier === "HIGH_UNCERTAINTY").length,
      },
    },
    policy: {
      verdict: "REVIEW_REQUIRED",
      autoDelete: false,
      minConfidence,
      includeTests,
      includeClassified,
    },
  };
}
