// Bounded HTTP-wrapper configuration and conservative auto-discovery. A wrapper is accepted only
// when its URL position and HTTP method are statically known; no source is evaluated.
import { statSync } from "node:fs";
import { createRepoBoundary } from "../repo-path.js";
import { safeRead } from "../util.js";

export const DEFAULT_HTTP_CLIENT_NAMES = Object.freeze([
  "axios", "http", "https", "$http", "httpClient", "apiClient", "restClient",
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_WRAPPERS = 100;
const MAX_CLIENT_NAMES = 40;
const MAX_DISCOVERY_BODY = 2_000;
const identifier = (value) => {
  const text = String(value || "").trim();
  return /^[A-Za-z_$][\w$]{0,127}$/.test(text) ? text : null;
};
const method = (value) => {
  const text = String(value || "").trim().toUpperCase();
  return HTTP_METHODS.has(text) ? text : null;
};
const argumentIndex = (value) => {
  const number = Number(value ?? 0);
  return Number.isInteger(number) && number >= 0 && number <= 5 ? number : null;
};

export function normalizeHttpClientNames(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .slice(0, MAX_CLIENT_NAMES)
    .map(identifier)
    .filter(Boolean))];
}

export function normalizeHttpWrapperDescriptors(values, source = "input") {
  const wrappers = [];
  for (const raw of (Array.isArray(values) ? values : []).slice(0, MAX_WRAPPERS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const urlArgument = argumentIndex(raw.urlArgument ?? raw.url_argument);
    const fixedMethod = method(raw.method);
    if (urlArgument == null || !fixedMethod) continue;
    const call = identifier(raw.call);
    const object = identifier(raw.object);
    const member = identifier(raw.member);
    if (call && !object && !member) {
      wrappers.push({ kind: "function", call, method: fixedMethod, urlArgument, source });
    } else if (!call && object && member) {
      wrappers.push({ kind: "member", object, member, method: fixedMethod, urlArgument, source });
    }
  }
  const seen = new Set();
  return wrappers.filter((wrapper) => {
    const key = `${wrapper.kind}\0${wrapper.call || wrapper.object}\0${wrapper.member || ""}\0${wrapper.method}\0${wrapper.urlArgument}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function loadHttpContractConfig(repoRoot) {
  const empty = { clientNames: [], wrappers: [], autoDiscoverWrappers: true, loaded: false, warnings: [] };
  const resolved = createRepoBoundary(repoRoot).resolve(".weavatrix.json");
  if (!resolved.ok) return empty;
  try {
    if (statSync(resolved.path).size > MAX_CONFIG_BYTES) return { ...empty, error: "config-too-large" };
    const raw = JSON.parse(safeRead(resolved.path));
    const config = raw?.httpContracts;
    if (config == null) return { ...empty, loaded: true };
    if (!config || typeof config !== "object" || Array.isArray(config)) return { ...empty, error: "invalid-http-contract-config" };
    const rawNames = Array.isArray(config.clientNames) ? config.clientNames : [];
    const rawWrappers = Array.isArray(config.wrappers) ? config.wrappers : [];
    const clientNames = normalizeHttpClientNames(rawNames);
    const wrappers = normalizeHttpWrapperDescriptors(rawWrappers, "config");
    const warnings = [];
    if (config.clientNames != null && !Array.isArray(config.clientNames)) warnings.push("httpContracts.clientNames must be an array");
    if (rawNames.length > MAX_CLIENT_NAMES) warnings.push("httpContracts.clientNames cap reached");
    if (clientNames.length < Math.min(rawNames.length, MAX_CLIENT_NAMES)) warnings.push("invalid httpContracts.clientNames entries skipped");
    if (config.wrappers != null && !Array.isArray(config.wrappers)) warnings.push("httpContracts.wrappers must be an array");
    if (rawWrappers.length > MAX_WRAPPERS) warnings.push("httpContracts.wrappers cap reached");
    if (wrappers.length < Math.min(rawWrappers.length, MAX_WRAPPERS)) warnings.push("invalid or duplicate httpContracts.wrappers entries skipped");
    if (config.autoDiscoverWrappers != null && typeof config.autoDiscoverWrappers !== "boolean") warnings.push("httpContracts.autoDiscoverWrappers must be boolean");
    return {
      clientNames,
      wrappers,
      autoDiscoverWrappers: config.autoDiscoverWrappers !== false,
      loaded: true,
      warnings,
    };
  } catch {
    return { ...empty, error: "invalid-config" };
  }
}

// Masks comments and strings while retaining indices and newlines. Wrapper discovery needs only
// declarations and a direct `client.verb(urlParam)` delegation, never literal contents.
function codeMask(text) {
  const chars = String(text || "").split("");
  let index = 0;
  while (index < chars.length) {
    const char = chars[index], next = chars[index + 1];
    if (char === "/" && next === "/") {
      chars[index++] = " "; chars[index++] = " ";
      while (index < chars.length && chars[index] !== "\n") chars[index++] = " ";
    } else if (char === "/" && next === "*") {
      chars[index++] = " "; chars[index++] = " ";
      while (index < chars.length) {
        if (chars[index] === "*" && chars[index + 1] === "/") { chars[index++] = " "; chars[index++] = " "; break; }
        if (chars[index] !== "\n") chars[index] = " ";
        index += 1;
      }
    } else if (char === "'" || char === '"' || char === "`") {
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
    } else index += 1;
  }
  return chars.join("");
}

function matchingBrace(mask, open) {
  let depth = 0;
  for (let index = open; index < Math.min(mask.length, open + MAX_DISCOVERY_BODY); index += 1) {
    if (mask[index] === "{") depth += 1;
    else if (mask[index] === "}" && --depth === 0) return index + 1;
  }
  return Math.min(mask.length, open + MAX_DISCOVERY_BODY);
}

function parameterNames(raw) {
  const parts = [];
  let start = 0, round = 0, square = 0, curly = 0, angle = 0;
  const text = String(raw || "");
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    if ((char === "," && round === 0 && square === 0 && curly === 0 && angle === 0) || index === text.length) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  const names = [];
  for (const part of parts.slice(0, 6)) {
    const match = /^\s*([A-Za-z_$][\w$]*)(?=\s*(?:[?:=]|$))/.exec(part);
    if (!match) return [];
    names.push(match[1]);
  }
  return names;
}

function escaped(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function delegatedWrapper(mask, definition, clientNames) {
  const body = mask.slice(definition.bodyStart, definition.bodyEnd);
  const clients = clientNames.map(escaped).join("|");
  if (!clients) return null;
  const delegate = new RegExp(`\\b(?:${clients})\\s*(?:\\?\\.|\\.)\\s*(get|post|put|patch|delete|head|options)\\s*(?:<[^>\\n]{1,200}>)?\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*(?=[,)])`, "gi");
  const matches = [];
  let found;
  while ((found = delegate.exec(body)) && matches.length < 3) {
    const urlArgument = definition.parameters.indexOf(found[2]);
    if (urlArgument >= 0) matches.push({ method: found[1].toUpperCase(), urlArgument });
  }
  const unique = [...new Map(matches.map((item) => [`${item.method}\0${item.urlArgument}`, item])).values()];
  return unique.length === 1 ? unique[0] : null;
}

export function discoverHttpWrappers(sources, clientNames = []) {
  const allowedClients = [...new Set([...DEFAULT_HTTP_CLIENT_NAMES, ...normalizeHttpClientNames(clientNames)])];
  const candidates = [];
  let truncated = false;
  for (const source of Array.isArray(sources) ? sources : []) {
    if (candidates.length >= MAX_WRAPPERS) { truncated = true; break; }
    const mask = codeMask(source.text);
    const definitions = [];
    const functions = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]{0,300})\)\s*(?::[^\n{]{1,200})?\s*\{/g;
    let match;
    while ((match = functions.exec(mask)) && definitions.length < MAX_WRAPPERS) {
      const open = functions.lastIndex - 1;
      definitions.push({ call: match[1], parameters: parameterNames(match[2]), bodyStart: open + 1, bodyEnd: matchingBrace(mask, open) - 1 });
    }
    const arrows = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:<[^>\n]{1,200}>\s*)?(?:\(([^)]{0,300})\)\s*(?::[^\n=]{1,200})?|([A-Za-z_$][\w$]*))\s*=>\s*/g;
    while ((match = arrows.exec(mask)) && definitions.length < MAX_WRAPPERS) {
      const parameters = parameterNames(match[2] ?? match[3]);
      const open = mask.indexOf("{", arrows.lastIndex);
      const block = open >= 0 && /^\s*\{/.test(mask.slice(arrows.lastIndex, open + 1));
      const bodyStart = block ? open + 1 : arrows.lastIndex;
      const bodyEnd = block ? matchingBrace(mask, open) - 1 : Math.min(mask.length, bodyStart + MAX_DISCOVERY_BODY, mask.indexOf(";", bodyStart) >= 0 ? mask.indexOf(";", bodyStart) : mask.length);
      definitions.push({ call: match[1], parameters, bodyStart, bodyEnd });
    }
    for (const definition of definitions) {
      if (!definition.parameters.length) continue;
      const delegated = delegatedWrapper(mask, definition, allowedClients);
      if (delegated && candidates.length < MAX_WRAPPERS) candidates.push({ kind: "function", call: definition.call, ...delegated, source: "auto", definitionFile: source.file });
      else if (delegated) truncated = true;
    }
  }

  const byCall = new Map();
  for (const candidate of candidates) {
    const entries = byCall.get(candidate.call) || [];
    entries.push(candidate);
    byCall.set(candidate.call, entries);
  }
  const wrappers = [], ambiguous = [];
  for (const [call, entries] of [...byCall.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const unique = [...new Map(entries.map((entry) => [`${entry.method}\0${entry.urlArgument}\0${entry.definitionFile}`, entry])).values()];
    if (unique.length === 1) wrappers.push(unique[0]);
    else ambiguous.push({ call, definitions: unique.length });
  }
  return { wrappers, ambiguous, truncated };
}
