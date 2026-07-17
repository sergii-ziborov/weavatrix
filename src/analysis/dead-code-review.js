// Conservative, source-free review queue for statically unreferenced code. This deliberately builds
// on computeDead instead of inventing a second liveness model. Candidates are evidence for review,
// never deletion instructions: framework entry, dynamic loading, reflection and public API surfaces
// lower confidence and remain explicit in the returned record.
import { computeDead, isFrameworkEntryFile } from "./dead-check.js";
import { createPathClassifier, hasPathClass } from "../path-classification.js";

const CONFIDENCE_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });
const CLASSIFIED_NON_PRODUCT = Object.freeze(["generated", "mock", "story", "docs", "benchmark", "temp"]);
const DYNAMIC_RE = /(?:\bimport\s*\(|\brequire\s*\(\s*(?!["'])|\bcreateRequire\s*\(|\b__import__\s*\(|\bimportlib\.|(?:^|[^\w.$])(?:eval|exec)\s*\()/m;
const REFLECTION_RE = /(?:\b(?:Class\.forName|get(?:Declared)?Method|getattr|setattr|hasattr|Method\.Invoke|GetMethod|GetProcAddress|dlsym)\s*\(|\b(?:globals|locals)\s*\(\s*\)\s*\[|\breflect\.[A-Za-z_$][\w$]*\s*\()/i;

const normalizedPath = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const lineOf = (node) => {
  const match = /@(\d+)$/.exec(String(node?.id || "")) || /L(\d+)/.exec(String(node?.source_location || ""));
  return match ? Number(match[1]) : 0;
};
const bareLabel = (value) => String(value || "").replace(/\s*\(.*$/, "").replace(/[()]/g, "").trim();

function kindOf(node) {
  const symbolKind = String(node?.symbol_kind || "").toLowerCase();
  if (symbolKind === "method" || symbolKind === "constructor") return "method";
  if (["function", "function_definition", "func", "fn"].includes(symbolKind)) return "function";
  // Old graphs may not retain symbol_kind. Only use call syntax as a compatibility fallback;
  // member_of alone also describes fields and must never promote them to methods.
  if (!symbolKind && /\([^)]*\)\s*$/.test(String(node?.label || ""))) return node?.member_of ? "method" : "function";
  return "symbol";
}

function isPublicSurface(node) {
  const visibility = String(node?.visibility || "").toLowerCase();
  return node?.exported === true || visibility === "public" || visibility === "protected";
}

function pathAllowed(info, { includeTests, includeClassified }) {
  if (!includeTests && hasPathClass(info, "test", "e2e")) return { ok: false, bucket: "tests" };
  if (!includeClassified && (info?.excluded || hasPathClass(info, ...CLASSIFIED_NON_PRODUCT))) {
    return { ok: false, bucket: "classified" };
  }
  return { ok: true };
}

function symbolCandidate(item, node, context) {
  const file = normalizedPath(item.file);
  const source = String(context.sources.get(file) || "");
  const pathInfo = context.classify(file, source);
  const publicSurface = isPublicSurface(node);
  const testOnly = item.testOnly === true;
  const externalEntry = context.entrySet.has(file) || isFrameworkEntryFile(file);
  const framework = context.frameworkByFile.get(file) || null;
  const dynamicFile = context.dynamicTargets.has(file) || DYNAMIC_RE.test(source);
  const reflectionFile = REFLECTION_RE.test(source);
  const kind = kindOf(node);
  const exactNoReference = context.exactNoReferenceIds.has(String(item.id));
  const internallyScoped = String(node?.visibility || "").toLowerCase() === "private"
    || (!publicSurface && ["method", "function"].includes(kind));
  // Static absence alone is never high-confidence dead code. High is reserved for a successfully
  // queried semantic declaration whose language server also returned no in-workspace references.
  let confidence = internallyScoped && exactNoReference ? "high" : "medium";
  const caveats = [];

  if (internallyScoped && !exactNoReference) {
    caveats.push("No complete exact semantic no-reference result is available for this declaration; static absence remains medium confidence.");
  }

  if (publicSurface) {
    confidence = "low";
    caveats.push("Public/exported APIs can be consumed by downstream packages, interfaces, reflection, dependency injection, templates, or configuration outside this repository.");
  }
  if (externalEntry || framework) {
    confidence = "low";
    caveats.push(framework?.reason || "This file is an externally entered or framework-owned surface; static inbound edges are not complete usage evidence.");
  }
  if (node?.decorated) {
    confidence = "low";
    caveats.push("Decorators/annotations can register this symbol without a direct caller.");
  }
  if (dynamicFile) {
    confidence = "low";
    caveats.push("The declaring file uses or is reached through dynamic loading, so the static graph can miss callers.");
  }
  if (reflectionFile || (publicSurface && context.repoSignals.reflection)) {
    confidence = "low";
    caveats.push("Reflection is present and may invoke names without a resolvable static edge.");
  }

  return {
    id: String(item.id),
    kind,
    classification: testOnly ? `test-only-${kind}` : publicSurface ? `public-${kind}` : kind === "method" ? "internal-method" : kind === "function" ? "internal-function" : "unreferenced-symbol",
    file,
    line: lineOf(node),
    symbol: bareLabel(node?.label || item.label),
    owner: node?.member_of || null,
    symbolKind: node?.symbol_kind || null,
    visibility: node?.visibility || (node?.exported ? "exported" : "internal"),
    confidence,
    reason: item.reason,
    evidence: [
      ...(testOnly ? [{kind: item.evidence || "graph", fact: `Only test/e2e consumers were found${item.testConsumerFiles?.length ? `: ${item.testConsumerFiles.join(", ")}` : "."}`}]
        : [{ kind: "graph", fact: "No inbound non-structural graph edge targets this symbol." }, { kind: "source-index", fact: "Its identifier has no second indexed occurrence that establishes a caller." }]),
      ...(exactNoReference ? [{kind: "exact-lsp", fact: "The active language server returned no in-workspace references for this exact declaration."}] : []),
    ],
    caveats,
    publicApi: publicSurface,
    externallyEnteredFile: externalEntry,
    pathClasses: pathInfo.classes || [],
    matchedPathRule: pathInfo.matchedRule || null,
    reviewAction: testOnly
      ? "Confirm that no production/config/framework consumer exists; decide whether the declaration is intentional test support or removable with its tests. Never auto-delete."
      : "Confirm with read_source, get_dependents, exact search, framework/config inspection and tests; never auto-delete.",
  };
}

function fileCandidate(item, symbols, context) {
  const file = normalizedPath(item.file);
  const source = String(context.sources.get(file) || "");
  const pathInfo = context.classify(file, source);
  const publicSymbols = symbols.filter((symbol) => symbol.publicApi);
  const dynamicFile = context.dynamicTargets.has(file) || DYNAMIC_RE.test(source);
  const reflectionFile = REFLECTION_RE.test(source);
  // Whole-file liveness always remains at most medium: external launchers/manifests can exist outside
  // the indexed import graph even when every internal symbol signal is otherwise strong.
  let confidence = "medium";
  const caveats = ["Files can be launched by scripts, plugins, manifests, framework conventions, generated consumers, or external tooling without an import edge."];
  if (publicSymbols.length) {
    confidence = "low";
    caveats.push(`${publicSymbols.length} indexed public/exported symbol(s) may be consumed outside this repository.`);
  }
  if (dynamicFile) {
    confidence = "low";
    caveats.push("Dynamic loading is present in or targets this file.");
  }
  if (reflectionFile) {
    confidence = "low";
    caveats.push("Reflection is present in this file.");
  }
  return {
    id: `file:${file}`,
    kind: "file",
    classification: "unreferenced-file",
    file,
    line: 1,
    symbol: null,
    owner: null,
    symbolKind: null,
    visibility: null,
    confidence,
    reason: item.reason,
    evidence: [
      { kind: "graph", fact: "No indexed module imports this file." },
      { kind: "symbol-liveness", fact: "Every indexed symbol in the file is statically unreferenced." },
    ],
    caveats,
    publicApi: publicSymbols.length > 0,
    externallyEnteredFile: false,
    pathClasses: pathInfo.classes || [],
    matchedPathRule: pathInfo.matchedRule || null,
    reviewAction: "Verify package scripts, manifests, framework discovery, dynamic loading and external consumers; never auto-delete.",
  };
}

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
    dynamicLoading: (graph.externalImports || []).some((entry) => entry?.dynamic) || [...sources.values()].some((text) => DYNAMIC_RE.test(String(text || ""))),
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
