import { detectEndpoints } from "../endpoints.js";
import { detectHttpClientCalls } from "./client-call-detection.js";
import { affectedForEndpoint, externalUseLiveness, handlerNodeEvidence, reverseRuntimeImports } from "./graph-context.js";
import { matchHttpContract, methodMatches, pathSegments, routeShapeContains, routeShapeMatches, suffixShapeMatch } from "./matching.js";
import {
  HTTP_CONTRACTS_V,
  HTTP_CONTRACT_METHODS,
  filesFromGraph,
  normalizeContractFile,
  normalizeHttpContractLimits,
  normalizeHttpContractPath,
  safeContractName,
} from "./shared.js";

const descriptorFiles = (descriptor) => descriptor.codeFiles || filesFromGraph(descriptor.graph);

function endpointFilter(endpoint, backendId, options) {
  if (options.method && endpoint.method !== options.method && endpoint.method !== "ANY" && endpoint.method !== "ALL") return false;
  if (options.path) {
    const requested = normalizeHttpContractPath(options.path);
    const endpointSegments = pathSegments(normalizeHttpContractPath(endpoint.path));
    const requestedSegments = pathSegments(requested);
    if (!requested || (!routeShapeMatches(endpointSegments, requestedSegments) && !routeShapeContains(endpointSegments, requestedSegments))) return false;
  }
  if (options.changedFiles?.size) {
    const file = normalizeContractFile(endpoint.file);
    if (!options.changedFiles.has(file) && !options.changedFiles.has(`${backendId}::${file}`)) return false;
  }
  return true;
}

export function analyzeHttpContracts(input = {}) {
  const limits = normalizeHttpContractLimits(input);
  const method = input.method ? String(input.method).toUpperCase() : null;
  if (method && !HTTP_CONTRACT_METHODS.has(method)) throw new Error("method must be a concrete HTTP method");
  const changedFiles = new Set((Array.isArray(input.changedFiles) ? input.changedFiles : []).map((file) => normalizeContractFile(file)).filter(Boolean));
  const backendDescriptors = (Array.isArray(input.backends) ? input.backends : input.backend ? [input.backend] : []).slice(0, 20);
  const clientDescriptors = (Array.isArray(input.clients) ? input.clients : input.client ? [input.client] : []).slice(0, 20);
  const completeness = [], backends = [];
  let endpointBudget = limits.maxEndpoints;
  for (let index = 0; index < backendDescriptors.length; index++) {
    const descriptor = backendDescriptors[index] || {};
    const id = safeContractName(descriptor.id, `backend-${index + 1}`);
    const candidates = descriptorFiles(descriptor).slice().sort();
    if (candidates.length > limits.maxBackendFiles) completeness.push(`${id}: backend file cap reached`);
    const detected = Array.isArray(descriptor.endpoints)
      ? descriptor.endpoints
      : detectEndpoints(descriptor.repoRoot, candidates.slice(0, limits.maxBackendFiles));
    const filtered = detected
      .filter((endpoint) => normalizeHttpContractPath(endpoint?.path) && normalizeContractFile(endpoint?.file) && endpointFilter(endpoint, id, { method, path: input.path, changedFiles }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method) || String(left.file).localeCompare(String(right.file)) || Number(left.line) - Number(right.line));
    if (filtered.length > endpointBudget) completeness.push(`${id}: endpoint cap reached`);
    const accepted = filtered.slice(0, endpointBudget);
    endpointBudget -= accepted.length;
    backends.push({ id, endpoints: accepted, graph: descriptor.graph });
  }

  const clients = [];
  for (let index = 0; index < clientDescriptors.length; index++) {
    const descriptor = clientDescriptors[index] || {};
    const id = safeContractName(descriptor.id, `client-${index + 1}`);
    const detected = detectHttpClientCalls(descriptor.repoRoot, descriptorFiles(descriptor), {
      maxFiles: limits.maxClientFiles,
      maxCalls: limits.maxCallsPerClient,
      clientNames: descriptor.clientNames || input.clientNames,
      wrappers: descriptor.wrappers || input.wrappers,
      autoDiscoverWrappers: descriptor.autoDiscoverWrappers ?? input.autoDiscoverWrappers,
      graph: descriptor.graph,
      includeTests: descriptor.includeTests ?? input.includeTests,
      runtimeValues: descriptor.runtimeValues || input.runtimeValues,
    });
    if (detected.truncated) completeness.push(`${id}: client scan cap reached`);
    for (const reason of detected.reasons || []) completeness.push(`${id}: ${reason}`);
    clients.push({
      id,
      calls: detected.calls,
      reverse: reverseRuntimeImports(descriptor.graph),
      filesScanned: detected.filesScanned,
      wrapperDiscovery: detected.discovery,
    });
  }

  const results = [];
  let matches = 0, methodMismatches = 0, callsiteCapReached = false;
  for (const backend of backends) {
    for (const endpoint of backend.endpoints) {
      const callsites = [];
      for (const client of clients) {
        for (const call of client.calls) {
          if (call.path && !methodMatches(endpoint.method, call.method)) {
            const expected = pathSegments(normalizeHttpContractPath(endpoint.path));
            const actual = pathSegments(call.path);
            if (routeShapeMatches(expected, actual) || suffixShapeMatch(expected, actual)) methodMismatches++;
            continue;
          }
          const match = matchHttpContract(endpoint, call);
          if (!match) continue;
          if (matches >= limits.maxMatches || callsites.length >= limits.maxCallsitesPerEndpoint) {
            callsiteCapReached = true;
            continue;
          }
          matches++;
          callsites.push({
            clientRepo: client.id,
            file: call.file,
            line: call.line,
            method: call.method,
            path: call.path,
            dynamic: call.dynamic,
            detector: call.detector,
            wrapper: call.wrapper,
            match,
          });
        }
      }
      callsites.sort((left, right) => right.match.score - left.match.score || left.clientRepo.localeCompare(right.clientRepo) || left.file.localeCompare(right.file) || left.line - right.line);
      const handlerEvidence = handlerNodeEvidence(endpoint, backend.graph);
      results.push({
        backend: backend.id,
        method: endpoint.method,
        path: endpoint.path,
        normalizedPath: normalizeHttpContractPath(endpoint.path),
        ...handlerEvidence,
        file: normalizeContractFile(endpoint.file) || null,
        line: Number(endpoint.line) || null,
        callsites,
        liveness: externalUseLiveness(callsites, handlerEvidence),
        affected: affectedForEndpoint(callsites, clients, limits),
      });
    }
  }
  if (callsiteCapReached) completeness.push("match or per-endpoint callsite cap reached");

  const uncertainAll = clients.flatMap((client) => client.calls
    .filter((call) => !call.path || call.unknownPrefix || call.partialDynamic || call.method === "UNKNOWN")
    .map((call) => ({
      clientRepo: client.id,
      file: call.file,
      line: call.line,
      method: call.method,
      reason: call.reason || "URL retains an unresolved dynamic component",
    })))
    .sort((left, right) => left.clientRepo.localeCompare(right.clientRepo) || left.file.localeCompare(right.file) || left.line - right.line);
  if (uncertainAll.length > limits.maxUncertain) completeness.push("uncertain callsite cap reached");
  if (uncertainAll.length) completeness.push(`${uncertainAll.length} dynamic HTTP callsite(s) remain UNKNOWN`);
  if (results.some((endpoint) => !endpoint.affected.complete)) completeness.push("affected-file traversal cap reached");

  return {
    httpContractsV: HTTP_CONTRACTS_V,
    status: completeness.length ? "partial" : "complete",
    filters: { method, path: input.path ? normalizeHttpContractPath(input.path) : null, changedFiles: [...changedFiles].sort() },
    limits,
    completeness: { complete: completeness.length === 0, reasons: [...new Set(completeness)] },
    totals: {
      backends: backends.length,
      clients: clients.length,
      endpoints: results.length,
      clientCalls: clients.reduce((sum, client) => sum + client.calls.length, 0),
      matches,
      methodMismatches,
      uncertainCalls: uncertainAll.length,
      notDeadExternalUse: results.filter((endpoint) => endpoint.liveness.status === "NOT_DEAD_EXTERNAL_USE").length,
      notDeadExternalHandlers: results.filter((endpoint) => endpoint.liveness.canSuppressDeadCandidate).length,
      possibleExternalUse: results.filter((endpoint) => endpoint.liveness.status === "POSSIBLE_EXTERNAL_USE").length,
      unknownLiveness: results.filter((endpoint) => endpoint.liveness.status === "UNKNOWN").length,
    },
    wrapperDiscovery: clients.map((client) => ({ clientRepo: client.id, ...client.wrapperDiscovery })),
    endpoints: results,
    uncertain: uncertainAll.slice(0, limits.maxUncertain),
  };
}
