// Per-candidate review records for the dead-code review queue, split out of dead-code-review.js so the
// orchestrator stays within the file budget. The confidence, caveat, evidence and verification model is
// unchanged; symbolCandidate and fileCandidate are pure over the context built by computeDeadCodeReview.
import { isFrameworkEntryFile } from "../dead-check.js";
import {
  hasDynamicCode, REFLECTION_CODE_RE as REFLECTION_RE, normalizedReviewPath as normalizedPath,
} from "./policy.js";

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

export function symbolCandidate(item, node, context) {
  const file = normalizedPath(item.file);
  const source = String(context.sources.get(file) || "");
  const pathInfo = context.classify(file, source);
  const publicSurface = isPublicSurface(node);
  const testOnly = item.testOnly === true;
  const externalEntry = context.entrySet.has(file) || isFrameworkEntryFile(file);
  const framework = context.frameworkByFile.get(file) || null;
  const dynamicFile = context.dynamicTargets.has(file) || hasDynamicCode(source, file);
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

  const evidenceTier = confidence === "high" && exactNoReference
    ? "STRONG_STATIC_EVIDENCE"
    : confidence === "low" ? "HIGH_UNCERTAINTY" : "BOUNDED_STATIC_EVIDENCE";
  const remainingChecks = [
    ...(!exactNoReference ? ["Run an exact language-server reference query for this declaration."] : []),
    ...(publicSurface ? ["Check downstream/external consumers of the public API."] : []),
    ...(externalEntry || framework ? ["Inspect framework registration and externally entered call paths."] : []),
    ...(dynamicFile ? ["Resolve dynamic import/require targets and name-based dispatch."] : []),
    ...(reflectionFile || (publicSurface && context.repoSignals.reflection) ? ["Inspect reflection/annotation/configuration consumers."] : []),
    "Run targeted tests after any removal.",
  ];

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
    evidenceTier,
    actionability: evidenceTier === "STRONG_STATIC_EVIDENCE" ? "PRIORITY_MANUAL_REVIEW" : "MANUAL_REVIEW",
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
    verification: {
      graphInboundRuntimeEdge: "NOT_FOUND",
      indexedSecondOccurrence: testOnly ? "TEST_ONLY" : "NOT_FOUND",
      exactLanguageServerReferences: exactNoReference ? "ZERO_CONFIRMED" : "NOT_CHECKED_OR_INCOMPLETE",
      recognizedEntryPoint: externalEntry ? "FOUND" : "NOT_FOUND",
      dynamicLoadingRisk: dynamicFile ? "PRESENT" : "NOT_OBSERVED_IN_DECLARING_FILE",
      reflectionRisk: reflectionFile || (publicSurface && context.repoSignals.reflection) ? "PRESENT" : "NOT_OBSERVED",
      publicApi: publicSurface ? "YES" : "NO",
      decision: "MANUAL_REVIEW_REQUIRED",
    },
    remainingChecks,
    autoDelete: false,
    reviewAction: testOnly
      ? "Confirm that no production/config/framework consumer exists; decide whether the declaration is intentional test support or removable with its tests. Never auto-delete."
      : "Confirm with read_source, get_dependents, exact search, framework/config inspection and tests; never auto-delete.",
  };
}

export function fileCandidate(item, symbols, context) {
  const file = normalizedPath(item.file);
  const source = String(context.sources.get(file) || "");
  const pathInfo = context.classify(file, source);
  const publicSymbols = symbols.filter((symbol) => symbol.publicApi);
  const dynamicFile = context.dynamicTargets.has(file) || hasDynamicCode(source, file);
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
  const remainingChecks = [
    "Inspect package scripts, manifests, framework/plugin discovery and deployment configuration.",
    "Check external launchers and consumers outside the indexed repository.",
    ...(dynamicFile ? ["Resolve dynamic import/require targets."] : []),
    ...(reflectionFile ? ["Inspect reflection/name-based consumers."] : []),
    "Run targeted tests after any removal.",
  ];
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
    evidenceTier: confidence === "low" ? "HIGH_UNCERTAINTY" : "BOUNDED_STATIC_EVIDENCE",
    actionability: "MANUAL_REVIEW",
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
    verification: {
      graphInboundModuleEdge: "NOT_FOUND",
      indexedSymbolsReferenced: "NONE",
      recognizedEntryPoint: "NOT_FOUND",
      dynamicLoadingRisk: dynamicFile ? "PRESENT" : "NOT_OBSERVED",
      reflectionRisk: reflectionFile ? "PRESENT" : "NOT_OBSERVED",
      externalConsumerCheck: "NOT_POSSIBLE_FROM_REPOSITORY_GRAPH",
      decision: "MANUAL_REVIEW_REQUIRED",
    },
    remainingChecks,
    autoDelete: false,
    reviewAction: "Verify package scripts, manifests, framework discovery, dynamic loading and external consumers; never auto-delete.",
  };
}
