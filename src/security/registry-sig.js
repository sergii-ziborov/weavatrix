// Curated malware-heuristic signature table (defensive scanning of INSTALLED dependencies) + pure
// classifiers. Same philosophy as infra-registry.js: deterministic patterns, near-zero-FP rules marked
// explicitly, and an allowlist that downgrades ONLY the noisy rules — NEVER the smoking-gun ones
// (miners, fetch+exec): supply-chain attacks trojan previously-good packages (event-stream lesson).
// DEPS_SECURITY_PLAN P5.
// Facade: signature tables live in registry-sig.rules.js, classifiers in registry-sig.classify.js.

export { MALWARE_ALLOWLIST, CONTENT_RULES } from "./registry-sig.rules.js";
export {
  classifyInstallScript,
  classifyContent,
  classifyPythonPth,
  NOISY_URL_KEYS,
  isDocFile,
  isBenignUrlContext,
  isCloudSdkMetadataUse,
  classifyResolvedUrl,
} from "./registry-sig.classify.js";
