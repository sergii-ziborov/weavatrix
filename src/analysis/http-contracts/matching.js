import { normalizeHttpContractPath } from "./shared.js";

export const pathSegments = (path) => String(path || "").split("/").filter(Boolean);
const parameter = (segment) => segment === ":param";
const wildcard = (segment) => segment === "*";

export function routeShapeMatches(endpointSegments, callSegments) {
  const catchAll = wildcard(endpointSegments.at(-1));
  if (catchAll ? callSegments.length < endpointSegments.length - 1 : endpointSegments.length !== callSegments.length) return false;
  const compared = catchAll ? endpointSegments.length - 1 : endpointSegments.length;
  for (let index = 0; index < compared; index++) {
    const expected = endpointSegments[index], actual = callSegments[index];
    if (parameter(expected)) continue;
    if (parameter(actual) || wildcard(actual) || expected !== actual) return false;
  }
  return true;
}

export function suffixShapeMatch(endpointSegments, callSegments) {
  if (endpointSegments.length === callSegments.length || Math.min(endpointSegments.length, callSegments.length) < 2) return false;
  if (endpointSegments.length < callSegments.length) return routeShapeMatches(endpointSegments, callSegments.slice(callSegments.length - endpointSegments.length));
  return routeShapeMatches(endpointSegments.slice(endpointSegments.length - callSegments.length), callSegments);
}

export function routeShapeContains(endpointSegments, requestedSegments) {
  if (!requestedSegments.length || requestedSegments.length > endpointSegments.length) return false;
  for (let start = 0; start <= endpointSegments.length - requestedSegments.length; start++) {
    if (routeShapeMatches(endpointSegments.slice(start, start + requestedSegments.length), requestedSegments)) return true;
  }
  return false;
}

export function methodMatches(endpointMethod, callMethod) {
  return endpointMethod === "ANY" || endpointMethod === "ALL" || endpointMethod === callMethod;
}

export function matchHttpContract(endpoint, call) {
  if (!call?.path || !methodMatches(String(endpoint?.method || "").toUpperCase(), call.method)) return null;
  const expected = pathSegments(normalizeHttpContractPath(endpoint.path));
  const actual = pathSegments(call.path);
  if (routeShapeMatches(expected, actual)) {
    if (call.unknownPrefix || call.partialDynamic) return { kind: "exact-dynamic", confidence: "medium", score: 0.78, reason: "method and normalized route shape match, but the client URL retains a dynamic component" };
    const concreteParameter = expected.some((segment, index) => parameter(segment) && !parameter(actual[index]));
    return {
      kind: "exact",
      confidence: "high",
      score: concreteParameter ? 0.96 : 1,
      reason: concreteParameter ? "method matches and a backend parameter accepts the concrete client segment" : "method and normalized route shape match exactly",
    };
  }
  if (suffixShapeMatch(expected, actual)) {
    const dynamic = call.dynamic || call.unknownPrefix || call.partialDynamic;
    return {
      kind: "suffix",
      confidence: dynamic ? "low" : "medium",
      score: dynamic ? 0.55 : 0.72,
      reason: dynamic ? "method matches and at least two trailing route segments match; the client prefix is dynamic" : "method matches and at least two trailing route segments match after a client/backend base-path difference",
    };
  }
  return null;
}
