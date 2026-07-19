import { createPathClassifier, hasPathClass } from "../../path-classification.js";
import { isWeavatrixIgnored, loadWeavatrixIgnore } from "../../path-ignore.js";
import { createRepoBoundary } from "../../repo-path.js";
import { safeRead } from "../../util.js";
import {
  discoverHttpWrappers,
  loadHttpContractConfig,
  normalizeHttpClientNames,
  normalizeHttpWrapperDescriptors,
} from "../http-contract-wrappers.js";
import { wrapperScopeFiles } from "./graph-context.js";
import { extractHttpClientCallsFromText } from "./client-call-parser.js";
import {
  HTTP_CONTRACT_DEFAULTS,
  HTTP_CONTRACT_HARD_LIMITS,
  boundedInteger,
  normalizeContractFile,
} from "./shared.js";

export function detectHttpClientCalls(repoRoot, codeFiles, options = {}) {
  const boundary = createRepoBoundary(repoRoot);
  if (!boundary.root) return { calls: [], truncated: false, filesScanned: 0, discovery: { enabled: false, configured: 0, discovered: 0, ambiguous: [] }, reasons: [] };
  const maxFiles = boundedInteger(options.maxFiles, HTTP_CONTRACT_DEFAULTS.maxClientFiles, 1, HTTP_CONTRACT_HARD_LIMITS.maxClientFiles);
  const maxCalls = boundedInteger(options.maxCalls, HTTP_CONTRACT_DEFAULTS.maxCallsPerClient, 1, HTTP_CONTRACT_HARD_LIMITS.maxCallsPerClient);
  const ignoreRules = loadWeavatrixIgnore(boundary.root);
  const classifier = createPathClassifier(boundary.root);
  const candidates = [...new Set((codeFiles || []).map((entry) => normalizeContractFile(entry?.path || entry)).filter(Boolean))].sort();
  let truncated = candidates.length > maxFiles;
  let filesScanned = 0;
  const sources = [], calls = [];
  for (const file of candidates.slice(0, maxFiles)) {
    if (!/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file) || isWeavatrixIgnored(file, ignoreRules)) continue;
    const classification = classifier.explain(file, { content: "" });
    if (classification.excluded || (!options.includeTests && hasPathClass(classification, "test", "e2e"))) continue;
    const resolved = boundary.resolve(file);
    if (!resolved.ok) continue;
    const text = safeRead(resolved.path);
    if (!text) continue;
    filesScanned++;
    sources.push({ file, text });
  }
  const config = loadHttpContractConfig(boundary.root);
  const clientNames = [...new Set([...normalizeHttpClientNames(options.clientNames), ...config.clientNames])];
  const configured = [...normalizeHttpWrapperDescriptors(options.wrappers, "input"), ...config.wrappers];
  const discoveryEnabled = options.autoDiscoverWrappers !== false && config.autoDiscoverWrappers !== false;
  const discovered = discoveryEnabled ? discoverHttpWrappers(sources, clientNames) : { wrappers: [], ambiguous: [], truncated: false };
  const scopedDiscovered = discovered.wrappers.map((wrapper) => ({
    ...wrapper,
    allowedFiles: wrapperScopeFiles(wrapper.definitionFile, options.graph),
  }));
  for (const { file, text } of sources) {
    const remaining = maxCalls - calls.length;
    if (remaining <= 0) { truncated = true; break; }
    const extracted = extractHttpClientCallsFromText(text, file, {
      clientNames,
      normalizedWrappers: [...configured, ...scopedDiscovered],
      maxCalls: remaining,
    });
    calls.push(...extracted.calls);
    if (extracted.truncated) truncated = true;
  }
  calls.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.method.localeCompare(right.method) || String(left.path).localeCompare(String(right.path)));
  const reasons = [];
  if (config.error) reasons.push(`HTTP contract config ${config.error}`);
  reasons.push(...(config.warnings || []));
  if (discovered.truncated) reasons.push("auto-discovered wrapper cap reached");
  if (discovered.ambiguous.length) reasons.push(`${discovered.ambiguous.length} ambiguous auto-discovered wrapper name(s) skipped`);
  return {
    calls,
    truncated,
    filesScanned,
    discovery: {
      enabled: discoveryEnabled,
      configured: configured.length,
      discovered: scopedDiscovered.length,
      ambiguous: discovered.ambiguous,
      truncated: discovered.truncated,
    },
    reasons,
  };
}
