// Stable public facade for cross-repository HTTP contract evidence.
export { HTTP_CONTRACTS_V, normalizeHttpContractPath } from "./http-contracts/shared.js";
export { extractHttpClientCallsFromText } from "./http-contracts/client-call-parser.js";
export { detectHttpClientCalls } from "./http-contracts/client-call-detection.js";
export { matchHttpContract } from "./http-contracts/matching.js";
export { analyzeHttpContracts } from "./http-contracts/analysis.js";
