// Cross-repository HTTP contract evidence: join routes exposed by backend repositories to literal or
// bounded-template HTTP calls in client repositories. Results contain metadata only (path/method and
// file:line), never source snippets or URL expressions.
import { folderModuleOf } from "./graph-analysis.edges.js";
import { detectEndpoints } from "./endpoints.js";
import { isStructuralRelation } from "../graph/relations.js";
import { createPathClassifier, hasPathClass } from "../path-classification.js";
import { isWeavatrixIgnored, loadWeavatrixIgnore } from "../path-ignore.js";
import { createRepoBoundary } from "../repo-path.js";
import { safeRead } from "../util.js";

export const HTTP_CONTRACTS_V = 1;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const DEFAULT_CLIENT_NAMES = Object.freeze(["axios", "http", "https", "$http", "httpClient", "apiClient", "restClient"]);
const DEFAULTS = Object.freeze({
  maxBackendFiles: 3_000,
  maxClientFiles: 3_000,
  maxEndpoints: 250,
  maxCallsPerClient: 2_000,
  maxMatches: 1_000,
  maxCallsitesPerEndpoint: 100,
  maxUncertain: 200,
  maxImpactDepth: 2,
  maxAffectedFiles: 100,
  maxScreens: 50,
  maxModules: 50,
});
const HARD = Object.freeze({
  maxBackendFiles: 3_000,
  maxClientFiles: 10_000,
  maxEndpoints: 500,
  maxCallsPerClient: 5_000,
  maxMatches: 5_000,
  maxCallsitesPerEndpoint: 500,
  maxUncertain: 1_000,
  maxImpactDepth: 5,
  maxAffectedFiles: 500,
  maxScreens: 200,
  maxModules: 200,
});

const endpointId = (value) => value && typeof value === "object" ? value.id : value;
const normalizeFile = (value) => {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:\//i.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return "";
  const normalized = raw.replace(/^\.\//, "");
  return normalized.split("/").some((part) => !part || part === "." || part === "..") ? "" : normalized;
};
const boundedInteger = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const safeName = (value, fallback) => {
  const text = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(text) ? text : fallback;
};
const lineAt = (text, index) => {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
};

function normalizeLimits(input = {}) {
  const result = {};
  for (const key of Object.keys(DEFAULTS)) result[key] = boundedInteger(input[key], DEFAULTS[key], key === "maxImpactDepth" ? 0 : 1, HARD[key]);
  return result;
}

export function normalizeHttpContractPath(value) {
  let path = String(value || "").trim();
  if (!path || path.length > 2_048) return null;
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    else if (/^\/\//.test(path)) path = new URL(`http:${path}`).pathname;
  } catch { return null; }
  const queryAt = path.search(/[?#]/);
  if (queryAt >= 0) path = path.slice(0, queryAt);
  path = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/\{[^/}]+\}/g, "/:param")
    .replace(/\/:([A-Za-z_$][\w$-]*)(?:\?)?/g, "/:param")
    .replace(/\/\*[^/]*/g, "/*")
    .replace(/\[(?:\.\.\.)?[^\]]+\]/g, "/:param")
    .replace(/\/+$/g, "") || "/";
  if (/[\x00-\x1f\x7f]/.test(path) || path.includes("..")) return null;
  return path;
}

function maskNonCode(text) {
  // Split by UTF-16 code unit so indices stay aligned with the original JS string even when a file
  // contains astral Unicode before a callsite.
  const chars = String(text || "").split("");
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    const next = chars[index + 1];
    if (char === "/" && next === "/") {
      chars[index++] = " "; chars[index++] = " ";
      while (index < chars.length && chars[index] !== "\n") chars[index++] = " ";
      continue;
    }
    if (char === "/" && next === "*") {
      chars[index++] = " "; chars[index++] = " ";
      while (index < chars.length) {
        if (chars[index] === "*" && chars[index + 1] === "/") { chars[index++] = " "; chars[index++] = " "; break; }
        if (chars[index] !== "\n") chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      chars[index++] = " ";
      while (index < chars.length) {
        if (chars[index] === "\\") {
          chars[index++] = " ";
          if (index < chars.length && chars[index] !== "\n") chars[index] = " ";
          index += 1;
          continue;
        }
        const closes = chars[index] === quote;
        if (chars[index] !== "\n") chars[index] = " ";
        index += 1;
        if (closes) break;
      }
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

function quotedArgument(text, start, quote) {
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      if (index + 1 >= text.length) break;
      value += text[index + 1];
      index += 1;
      continue;
    }
    if (char === quote) return { value, endIndex: index + 1 };
    if (char === "\n" || char === "\r") break;
    value += char;
  }
  return null;
}

function templateArgument(text, start, constants = null, requireStatic = false) {
  let value = "";
  let dynamicSegments = 0;
  let unknownPrefix = false;
  let partialDynamic = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      if (index + 1 >= text.length) break;
      value += text[index + 1];
      index += 1;
      continue;
    }
    if (char === "`") return { value, endIndex: index + 1, dynamicSegments, unknownPrefix, partialDynamic };
    if (char !== "$" || text[index + 1] !== "{") {
      value += char;
      continue;
    }
    let cursor = index + 2;
    let depth = 1;
    let quote = null;
    while (cursor < text.length && depth > 0) {
      const token = text[cursor];
      if (quote) {
        if (token === "\\") cursor += 2;
        else { if (token === quote) quote = null; cursor += 1; }
        continue;
      }
      if (token === "'" || token === '"' || token === "`") { quote = token; cursor += 1; continue; }
      if (token === "{") depth += 1;
      else if (token === "}") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) return null;
    const expression = text.slice(index + 2, cursor - 1).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(expression) && constants?.has(expression)) {
      value += constants.get(expression);
      index = cursor - 1;
      continue;
    }
    if (requireStatic) return null;
    const next = text[cursor];
    const leftBoundary = value === "" || value.endsWith("/");
    const rightBoundary = !next || next === "/" || next === "?" || next === "#" || next === "`";
    dynamicSegments += 1;
    if (value === "" && next === "/") unknownPrefix = true;
    else if (leftBoundary && rightBoundary) value += ":param";
    else { value += ":dynamic"; partialDynamic = true; }
    index = cursor - 1;
  }
  return null;
}

function extractStaticStringConstants(text) {
  const source = String(text || "");
  const mask = maskNonCode(source);
  const declarations = [];
  const declaration = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
  let match;
  while ((match = declaration.exec(mask)) && declarations.length < 500) {
    let start = match.index + match[0].length;
    while (/\s/.test(source[start] || "")) start += 1;
    declarations.push({ name: match[1], start });
  }

  const constants = new Map();
  for (const item of declarations) {
    const quote = source[item.start];
    if (quote !== "'" && quote !== '"') continue;
    const parsed = quotedArgument(source, item.start, quote);
    if (parsed && parsed.value.length <= 2_048) constants.set(item.name, parsed.value);
  }
  // Resolve bounded chains such as `const route = `${API_ROOT}/query`` without evaluating code.
  for (let pass = 0; pass < Math.min(8, declarations.length); pass += 1) {
    let changed = false;
    for (const item of declarations) {
      if (constants.has(item.name) || source[item.start] !== "`") continue;
      const parsed = templateArgument(source, item.start, constants, true);
      if (!parsed || parsed.value.length > 2_048) continue;
      constants.set(item.name, parsed.value);
      changed = true;
    }
    if (!changed) break;
  }
  return constants;
}

function parseUrlArgument(text, openParen, constants) {
  let start = openParen + 1;
  while (/\s/.test(text[start] || "")) start += 1;
  const quote = text[start];
  if (quote === "'" || quote === '"') {
    const parsed = quotedArgument(text, start, quote);
    if (!parsed) return { path: null, endIndex: start, kind: "dynamic", dynamic: true, reason: "unterminated URL literal" };
    return { path: normalizeHttpContractPath(parsed.value), endIndex: parsed.endIndex, kind: "literal", dynamic: false, unknownPrefix: false, partialDynamic: false, reason: null };
  }
  if (quote === "`") {
    const parsed = templateArgument(text, start, constants);
    if (!parsed) return { path: null, endIndex: start, kind: "dynamic", dynamic: true, reason: "unterminated URL template" };
    return {
      path: normalizeHttpContractPath(parsed.value),
      endIndex: parsed.endIndex,
      kind: parsed.dynamicSegments ? "template" : "literal",
      dynamic: parsed.dynamicSegments > 0,
      unknownPrefix: parsed.unknownPrefix,
      partialDynamic: parsed.partialDynamic,
      reason: parsed.partialDynamic ? "URL template contains a partial dynamic segment" : null,
    };
  }
  return { path: null, endIndex: start, kind: "dynamic", dynamic: true, unknownPrefix: false, partialDynamic: true, reason: "URL argument is not a string or template literal" };
}

function fetchMethod(text, argumentEnd) {
  const tail = text.slice(argumentEnd, argumentEnd + 500);
  if (!/^\s*,/.test(tail)) return { method: "GET", uncertain: false };
  const config = tail.replace(/^\s*,\s*/, "");
  if (!config.startsWith("{") || /^\{\s*\.\.\./.test(config)) return { method: "UNKNOWN", uncertain: true };
  const literal = /\bmethod\s*:\s*(["'`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/i.exec(tail);
  if (literal) return { method: literal[2].toUpperCase(), uncertain: false };
  if (/\bmethod\s*:/.test(tail)) return { method: "UNKNOWN", uncertain: true };
  return { method: "GET", uncertain: false };
}

function normalizedClientNames(values) {
  return new Set([...DEFAULT_CLIENT_NAMES, ...(Array.isArray(values) ? values : [])]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[a-z_$][\w$]*$/i.test(value)));
}

export function extractHttpClientCallsFromText(text, file, options = {}) {
  const source = String(text || "");
  const mask = maskNonCode(source);
  const constants = extractStaticStringConstants(source);
  const allowed = normalizedClientNames(options.clientNames);
  const maxCalls = boundedInteger(options.maxCalls, DEFAULTS.maxCallsPerClient, 1, HARD.maxCallsPerClient);
  const calls = [];
  let truncated = false;
  const add = (clientName, method, openParen, fetch = false) => {
    if (calls.length >= maxCalls) { truncated = true; return; }
    const parsed = parseUrlArgument(source, openParen, constants);
    const fetchInfo = fetch ? fetchMethod(source, parsed.endIndex) : { method: method.toUpperCase(), uncertain: false };
    calls.push({
      file: normalizeFile(file),
      line: lineAt(source, openParen),
      client: clientName,
      method: fetchInfo.method,
      path: parsed.path,
      kind: parsed.kind,
      dynamic: parsed.dynamic,
      unknownPrefix: Boolean(parsed.unknownPrefix),
      partialDynamic: Boolean(parsed.partialDynamic || fetchInfo.uncertain),
      reason: fetchInfo.uncertain ? "HTTP method is dynamic" : parsed.reason,
    });
  };

  const member = /(^|[^\w$])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*(get|post|put|patch|delete|head|options)\s*\(/gim;
  let match;
  while ((match = member.exec(mask))) {
    if (!allowed.has(match[2].toLowerCase())) continue;
    add(match[2], match[3], member.lastIndex - 1, false);
  }
  const fetchCall = /(^|[^\w$])fetch\s*\(/gim;
  while ((match = fetchCall.exec(mask))) add("fetch", "GET", fetchCall.lastIndex - 1, true);
  calls.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.method.localeCompare(right.method) || String(left.path).localeCompare(String(right.path)));
  return { calls, truncated };
}

function filesFromGraph(graph) {
  return [...new Set((graph?.nodes || []).map((node) => normalizeFile(node?.source_file)).filter(Boolean))].sort();
}

export function detectHttpClientCalls(repoRoot, codeFiles, options = {}) {
  const boundary = createRepoBoundary(repoRoot);
  if (!boundary.root) return { calls: [], truncated: false, filesScanned: 0 };
  const maxFiles = boundedInteger(options.maxFiles, DEFAULTS.maxClientFiles, 1, HARD.maxClientFiles);
  const maxCalls = boundedInteger(options.maxCalls, DEFAULTS.maxCallsPerClient, 1, HARD.maxCallsPerClient);
  const ignoreRules = loadWeavatrixIgnore(boundary.root);
  const classifier = createPathClassifier(boundary.root);
  const candidates = [...new Set((codeFiles || []).map((entry) => normalizeFile(entry?.path || entry)).filter(Boolean))].sort();
  let truncated = candidates.length > maxFiles;
  let filesScanned = 0;
  const calls = [];
  for (const file of candidates.slice(0, maxFiles)) {
    if (!/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file) || isWeavatrixIgnored(file, ignoreRules)) continue;
    const classification = classifier.explain(file, { content: "" });
    if (classification.excluded || (!options.includeTests && hasPathClass(classification, "test", "e2e"))) continue;
    const resolved = boundary.resolve(file);
    if (!resolved.ok) continue;
    const text = safeRead(resolved.path);
    if (!text) continue;
    filesScanned += 1;
    const remaining = maxCalls - calls.length;
    if (remaining <= 0) { truncated = true; break; }
    const extracted = extractHttpClientCallsFromText(text, file, { clientNames: options.clientNames, maxCalls: remaining });
    calls.push(...extracted.calls);
    if (extracted.truncated) truncated = true;
  }
  calls.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.method.localeCompare(right.method) || String(left.path).localeCompare(String(right.path)));
  return { calls, truncated, filesScanned };
}

function pathSegments(path) {
  return String(path || "").split("/").filter(Boolean);
}
const parameter = (segment) => segment === ":param";
const wildcard = (segment) => segment === "*";

function routeShapeMatches(endpointSegments, callSegments) {
  const catchAll = wildcard(endpointSegments.at(-1));
  if (catchAll ? callSegments.length < endpointSegments.length - 1 : endpointSegments.length !== callSegments.length) return false;
  const compared = catchAll ? endpointSegments.length - 1 : endpointSegments.length;
  for (let index = 0; index < compared; index += 1) {
    const expected = endpointSegments[index];
    const actual = callSegments[index];
    if (parameter(expected)) continue;
    if (parameter(actual) || wildcard(actual) || expected !== actual) return false;
  }
  return true;
}

function suffixShapeMatch(endpointSegments, callSegments) {
  if (endpointSegments.length === callSegments.length || Math.min(endpointSegments.length, callSegments.length) < 2) return false;
  if (endpointSegments.length < callSegments.length) {
    return routeShapeMatches(endpointSegments, callSegments.slice(callSegments.length - endpointSegments.length));
  }
  return routeShapeMatches(endpointSegments.slice(endpointSegments.length - callSegments.length), callSegments);
}

function routeShapeContains(endpointSegments, requestedSegments) {
  if (!requestedSegments.length || requestedSegments.length > endpointSegments.length) return false;
  for (let start = 0; start <= endpointSegments.length - requestedSegments.length; start += 1) {
    if (routeShapeMatches(endpointSegments.slice(start, start + requestedSegments.length), requestedSegments)) return true;
  }
  return false;
}

function methodMatches(endpointMethod, callMethod) {
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

function reverseImports(graph = {}) {
  const byId = new Map();
  const files = new Set();
  for (const node of graph.nodes || []) {
    const file = normalizeFile(node?.source_file);
    if (!file) continue;
    byId.set(String(node.id), file);
    files.add(file);
  }
  const reverse = new Map([...files].map((file) => [file, new Set()]));
  for (const link of graph.links || []) {
    if (isStructuralRelation(link?.relation) || !["imports", "re_exports"].includes(link?.relation) || link?.typeOnly === true || link?.compileOnly === true || link?.barrelProxy === true) continue;
    const importer = byId.get(String(endpointId(link.source)));
    const imported = byId.get(String(endpointId(link.target)));
    if (!importer || !imported || importer === imported) continue;
    reverse.get(imported)?.add(importer);
  }
  return reverse;
}

function isScreen(file) {
  const path = normalizeFile(file);
  const base = path.split("/").at(-1) || "";
  return /(^|\/)(pages?|screens?|views?|routes?)(\/|$)/i.test(path)
    || /(^|\/)(?:page|layout)\.[cm]?[jt]sx?$/i.test(path)
    || /^(?:App|Root)\.[cm]?[jt]sx?$/i.test(base);
}

function affectedForEndpoint(callsites, clientContexts, limits) {
  const collected = new Map();
  let traversalTruncated = false;
  for (const context of clientContexts) {
    const seeds = callsites.filter((call) => call.clientRepo === context.id).map((call) => call.file).sort();
    if (!seeds.length) continue;
    const queue = [];
    const distance = new Map();
    for (const seed of seeds) if (!distance.has(seed)) { distance.set(seed, 0); queue.push(seed); }
    while (queue.length) {
      const file = queue.shift();
      const depth = distance.get(file);
      const key = `${context.id}\0${file}`;
      const previous = collected.get(key);
      if (!previous || depth < previous.distance) collected.set(key, { client: context.id, file, distance: depth });
      if (depth >= limits.maxImpactDepth) continue;
      for (const importer of [...(context.reverse.get(file) || [])].sort()) {
        if (distance.has(importer)) continue;
        if (distance.size >= limits.maxAffectedFiles * 2) { traversalTruncated = true; continue; }
        distance.set(importer, depth + 1);
        queue.push(importer);
      }
    }
  }
  const allFiles = [...collected.values()].sort((left, right) => left.distance - right.distance || left.client.localeCompare(right.client) || left.file.localeCompare(right.file));
  const filesTruncated = allFiles.length > limits.maxAffectedFiles;
  const files = allFiles.slice(0, limits.maxAffectedFiles);
  const allScreens = files.filter((entry) => isScreen(entry.file));
  const screensTruncated = allScreens.length > limits.maxScreens;
  const screens = allScreens.slice(0, limits.maxScreens);
  const moduleMap = new Map();
  for (const entry of files) {
    const module = folderModuleOf(entry.file);
    const key = `${entry.client}\0${module}`;
    const item = moduleMap.get(key) || { client: entry.client, module, files: 0, nearestDistance: entry.distance };
    item.files += 1;
    item.nearestDistance = Math.min(item.nearestDistance, entry.distance);
    moduleMap.set(key, item);
  }
  const allModules = [...moduleMap.values()].sort((left, right) => left.nearestDistance - right.nearestDistance || right.files - left.files || left.client.localeCompare(right.client) || left.module.localeCompare(right.module));
  const modulesTruncated = allModules.length > limits.maxModules;
  return {
    complete: !(traversalTruncated || filesTruncated || screensTruncated || modulesTruncated),
    files,
    screens,
    modules: allModules.slice(0, limits.maxModules),
    truncated: { traversal: traversalTruncated, files: filesTruncated, screens: screensTruncated, modules: modulesTruncated },
  };
}

function descriptorFiles(descriptor) {
  return descriptor.codeFiles || filesFromGraph(descriptor.graph);
}

function endpointFilter(endpoint, backendId, options) {
  if (options.method && endpoint.method !== options.method && endpoint.method !== "ANY" && endpoint.method !== "ALL") return false;
  if (options.path) {
    const requested = normalizeHttpContractPath(options.path);
    const endpointSegments = pathSegments(normalizeHttpContractPath(endpoint.path));
    const requestedSegments = pathSegments(requested);
    if (!requested || (!routeShapeMatches(endpointSegments, requestedSegments) && !routeShapeContains(endpointSegments, requestedSegments))) return false;
  }
  if (options.changedFiles?.size) {
    const file = normalizeFile(endpoint.file);
    if (!options.changedFiles.has(file) && !options.changedFiles.has(`${backendId}::${file}`)) return false;
  }
  return true;
}

// `backends` and `clients` are arrays of {id, repoRoot, codeFiles?, graph?}. Backends may optionally
// supply a precomputed `endpoints` array; otherwise the shared multi-language endpoint detector is used.
export function analyzeHttpContracts(input = {}) {
  const limits = normalizeLimits(input);
  const method = input.method ? String(input.method).toUpperCase() : null;
  if (method && !METHODS.has(method)) throw new Error("method must be a concrete HTTP method");
  const changedFiles = new Set((Array.isArray(input.changedFiles) ? input.changedFiles : []).map((file) => normalizeFile(file)).filter(Boolean));
  const backendDescriptors = (Array.isArray(input.backends) ? input.backends : input.backend ? [input.backend] : []).slice(0, 20);
  const clientDescriptors = (Array.isArray(input.clients) ? input.clients : input.client ? [input.client] : []).slice(0, 20);
  const completeness = [];
  const backends = [];
  let endpointBudget = limits.maxEndpoints;
  for (let index = 0; index < backendDescriptors.length; index += 1) {
    const descriptor = backendDescriptors[index] || {};
    const id = safeName(descriptor.id, `backend-${index + 1}`);
    const candidates = descriptorFiles(descriptor).slice().sort();
    if (candidates.length > limits.maxBackendFiles) completeness.push(`${id}: backend file cap reached`);
    const detected = Array.isArray(descriptor.endpoints)
      ? descriptor.endpoints
      : detectEndpoints(descriptor.repoRoot, candidates.slice(0, limits.maxBackendFiles));
    const filtered = detected.filter((endpoint) => normalizeHttpContractPath(endpoint?.path) && normalizeFile(endpoint?.file) && endpointFilter(endpoint, id, { method, path: input.path, changedFiles })).sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method) || String(left.file).localeCompare(String(right.file)) || Number(left.line) - Number(right.line));
    if (filtered.length > endpointBudget) completeness.push(`${id}: endpoint cap reached`);
    const accepted = filtered.slice(0, endpointBudget);
    endpointBudget -= accepted.length;
    backends.push({ id, endpoints: accepted });
  }

  const clients = [];
  for (let index = 0; index < clientDescriptors.length; index += 1) {
    const descriptor = clientDescriptors[index] || {};
    const id = safeName(descriptor.id, `client-${index + 1}`);
    const detected = detectHttpClientCalls(descriptor.repoRoot, descriptorFiles(descriptor), {
      maxFiles: limits.maxClientFiles,
      maxCalls: limits.maxCallsPerClient,
      clientNames: descriptor.clientNames || input.clientNames,
      includeTests: descriptor.includeTests ?? input.includeTests,
    });
    if (detected.truncated) completeness.push(`${id}: client scan cap reached`);
    clients.push({ id, calls: detected.calls, reverse: reverseImports(descriptor.graph), filesScanned: detected.filesScanned });
  }

  const results = [];
  let matches = 0;
  let methodMismatches = 0;
  let callsiteCapReached = false;
  for (const backend of backends) {
    for (const endpoint of backend.endpoints) {
      const callsites = [];
      for (const client of clients) {
        for (const call of client.calls) {
          if (call.path && !methodMatches(endpoint.method, call.method)) {
            const expected = pathSegments(normalizeHttpContractPath(endpoint.path));
            const actual = pathSegments(call.path);
            if (routeShapeMatches(expected, actual) || suffixShapeMatch(expected, actual)) methodMismatches += 1;
            continue;
          }
          const match = matchHttpContract(endpoint, call);
          if (!match) continue;
          if (matches >= limits.maxMatches || callsites.length >= limits.maxCallsitesPerEndpoint) {
            callsiteCapReached = true;
            continue;
          }
          matches += 1;
          callsites.push({
            clientRepo: client.id,
            file: call.file,
            line: call.line,
            method: call.method,
            path: call.path,
            dynamic: call.dynamic,
            match,
          });
        }
      }
      callsites.sort((left, right) => right.match.score - left.match.score || left.clientRepo.localeCompare(right.clientRepo) || left.file.localeCompare(right.file) || left.line - right.line);
      results.push({
        backend: backend.id,
        method: endpoint.method,
        path: endpoint.path,
        normalizedPath: normalizeHttpContractPath(endpoint.path),
        handler: /^[A-Za-z_$][\w$]{0,127}$/.test(String(endpoint.handler || "")) ? String(endpoint.handler) : null,
        file: normalizeFile(endpoint.file) || null,
        line: Number(endpoint.line) || null,
        callsites,
        affected: affectedForEndpoint(callsites, clients, limits),
      });
    }
  }
  if (callsiteCapReached) completeness.push("match or per-endpoint callsite cap reached");

  const uncertainAll = clients.flatMap((client) => client.calls.filter((call) => !call.path || call.unknownPrefix || call.partialDynamic || call.method === "UNKNOWN").map((call) => ({
    clientRepo: client.id,
    file: call.file,
    line: call.line,
    method: call.method,
    reason: call.reason || "URL retains an unresolved dynamic component",
  }))).sort((left, right) => left.clientRepo.localeCompare(right.clientRepo) || left.file.localeCompare(right.file) || left.line - right.line);
  if (uncertainAll.length > limits.maxUncertain) completeness.push("uncertain callsite cap reached");
  const affectedPartial = results.some((endpoint) => !endpoint.affected.complete);
  if (affectedPartial) completeness.push("affected-file traversal cap reached");

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
    },
    endpoints: results,
    uncertain: uncertainAll.slice(0, limits.maxUncertain),
  };
}
