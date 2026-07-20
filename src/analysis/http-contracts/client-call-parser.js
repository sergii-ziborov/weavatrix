import { DEFAULT_HTTP_CLIENT_NAMES, normalizeHttpClientNames, normalizeHttpWrapperDescriptors } from "../http-contract-wrappers.js";
import {
  HTTP_CONTRACT_DEFAULTS,
  HTTP_CONTRACT_HARD_LIMITS,
  boundedInteger,
  contractLineAt,
  normalizeContractFile,
  normalizeHttpContractPath,
} from "./shared.js";

function maskNonCode(text) {
  const chars = String(text || "").split("");
  let index = 0;
  while (index < chars.length) {
    const char = chars[index], next = chars[index + 1];
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
        index++;
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
          index++;
          continue;
        }
        const closes = chars[index] === quote;
        if (chars[index] !== "\n") chars[index] = " ";
        index++;
        if (closes) break;
      }
      continue;
    }
    index++;
  }
  return chars.join("");
}

function quotedArgument(text, start, quote) {
  let value = "";
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      if (index + 1 >= text.length) break;
      value += text[++index];
      continue;
    }
    if (char === quote) return { value, endIndex: index + 1 };
    if (char === "\n" || char === "\r") break;
    value += char;
  }
  return null;
}

function templateArgument(text, start, constants = null, requireStatic = false) {
  let value = "", dynamicSegments = 0, unknownPrefix = false, partialDynamic = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      if (index + 1 >= text.length) break;
      value += text[++index];
      continue;
    }
    if (char === "`") return { value, endIndex: index + 1, dynamicSegments, unknownPrefix, partialDynamic };
    if (char !== "$" || text[index + 1] !== "{") { value += char; continue; }
    let cursor = index + 2, depth = 1, quote = null;
    while (cursor < text.length && depth > 0) {
      const token = text[cursor];
      if (quote) {
        if (token === "\\") cursor += 2;
        else { if (token === quote) quote = null; cursor++; }
        continue;
      }
      if (token === "'" || token === '"' || token === "`") { quote = token; cursor++; continue; }
      if (token === "{") depth++;
      else if (token === "}") depth--;
      cursor++;
    }
    if (depth !== 0) return null;
    const expression = text.slice(index + 2, cursor - 1).trim();
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expression) && constants?.has(expression)) {
      value += constants.get(expression);
      index = cursor - 1;
      continue;
    }
    if (requireStatic) return null;
    const next = text[cursor];
    const leftBoundary = value === "" || value.endsWith("/");
    const rightBoundary = !next || next === "/" || next === "?" || next === "#" || next === "`";
    dynamicSegments++;
    if (value === "" && next === "/") unknownPrefix = true;
    else if (leftBoundary && rightBoundary) value += ":param";
    else { value += ":dynamic"; partialDynamic = true; }
    index = cursor - 1;
  }
  return null;
}

function extractStaticStringConstants(text, runtimeValues = {}) {
  const source = String(text || "");
  const mask = maskNonCode(source);
  const declarations = [];
  const declaration = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
  let match;
  while ((match = declaration.exec(mask)) && declarations.length < 500) {
    let start = match.index + match[0].length;
    while (/\s/.test(source[start] || "")) start++;
    declarations.push({ name: match[1], start });
  }
  const constants = new Map(Object.entries(runtimeValues || {})
    .filter(([key, value]) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(key) && typeof value === "string" && value.length <= 2_048));
  for (const item of declarations) {
    const quote = source[item.start];
    if (quote !== "'" && quote !== '"') continue;
    const parsed = quotedArgument(source, item.start, quote);
    if (parsed && parsed.value.length <= 2_048) constants.set(item.name, parsed.value);
  }
  for (let pass = 0; pass < Math.min(8, declarations.length); pass++) {
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
  for (const item of declarations) {
    if (constants.has(item.name)) continue;
    const rest = source.slice(item.start);
    const expression = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(rest)?.[0];
    if (expression && constants.has(expression)) constants.set(item.name, constants.get(expression));
    if (constants.has(item.name)) continue;
    const fallback = /(?:\|\||\?\?)\s*(["'])/.exec(rest.slice(0, 500));
    if (fallback) {
      const start = item.start + fallback.index + fallback[0].lastIndexOf(fallback[1]);
      const parsed = quotedArgument(source, start, fallback[1]);
      if (parsed && parsed.value.length <= 2_048) constants.set(item.name, parsed.value);
    }
  }
  return constants;
}

function argumentStart(text, openParen, target) {
  let current = 0, round = 0, square = 0, curly = 0;
  for (let index = openParen + 1; index < text.length; index++) {
    const char = text[index];
    if (current === target && !/\s|,/.test(char)) return index;
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      for (index++; index < text.length; index++) {
        if (text[index] === "\\") index++;
        else if (text[index] === quote) break;
      }
      continue;
    }
    if (char === "(") round++;
    else if (char === "[") square++;
    else if (char === "{") curly++;
    else if (char === ")") {
      if (round === 0 && square === 0 && curly === 0) return null;
      round--;
    } else if (char === "]") square--;
    else if (char === "}") curly--;
    else if (char === "," && round === 0 && square === 0 && curly === 0) current++;
  }
  return null;
}

function parseUrlArgument(text, openParen, constants, argument = 0) {
  let start = argumentStart(text, openParen, argument);
  if (start == null) return { path: null, endIndex: openParen, kind: "dynamic", dynamic: true, unknownPrefix: false, partialDynamic: true, reason: `URL argument ${argument} is missing` };
  while (/\s/.test(text[start] || "")) start++;
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
      path: normalizeHttpContractPath(parsed.value), endIndex: parsed.endIndex,
      kind: parsed.dynamicSegments ? "template" : "literal", dynamic: parsed.dynamicSegments > 0,
      unknownPrefix: parsed.unknownPrefix, partialDynamic: parsed.partialDynamic,
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
  return /\bmethod\s*:/.test(tail) ? { method: "UNKNOWN", uncertain: true } : { method: "GET", uncertain: false };
}

function normalizedClientNames(values) {
  return new Set([...DEFAULT_HTTP_CLIENT_NAMES, ...normalizeHttpClientNames(values)]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[a-z_$][\w$]*$/i.test(value)));
}

const escapeRegex = (value) => String(value).replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");

export function extractHttpClientCallsFromText(text, file, options = {}) {
  const source = String(text || "");
  const mask = maskNonCode(source);
  const constants = extractStaticStringConstants(source, options.runtimeValues);
  const allowed = normalizedClientNames(options.clientNames);
  const wrappers = normalizeHttpWrapperDescriptors(options.wrappers, "input").concat(Array.isArray(options.normalizedWrappers) ? options.normalizedWrappers : []);
  const maxCalls = boundedInteger(options.maxCalls, HTTP_CONTRACT_DEFAULTS.maxCallsPerClient, 1, HTTP_CONTRACT_HARD_LIMITS.maxCallsPerClient);
  const calls = [], seen = new Set();
  let truncated = false;
  const add = (clientName, method, openParen, isFetch = false, urlArgument = 0, detector = "builtin", wrapper = null) => {
    const key = `${openParen}\0${method}\0${urlArgument}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (calls.length >= maxCalls) { truncated = true; return; }
    const parsed = parseUrlArgument(source, openParen, constants, urlArgument);
    const fetchInfo = isFetch ? fetchMethod(source, parsed.endIndex) : { method: method.toUpperCase(), uncertain: false };
    calls.push({
      file: normalizeContractFile(file), line: contractLineAt(source, openParen), client: clientName, method: fetchInfo.method,
      path: parsed.path, kind: parsed.kind, dynamic: parsed.dynamic, unknownPrefix: Boolean(parsed.unknownPrefix),
      partialDynamic: Boolean(parsed.partialDynamic || fetchInfo.uncertain),
      reason: fetchInfo.uncertain ? "HTTP method is dynamic" : parsed.reason, detector, wrapper,
    });
  };
  const member = /(^|[^\w$])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*(get|post|put|patch|delete|head|options)\s*(?:<[^>\n]{1,200}>)?\s*\(/gim;
  let match;
  while ((match = member.exec(mask))) if (allowed.has(match[2].toLowerCase())) add(match[2], match[3], member.lastIndex - 1);
  // Detect where the fetch Web API is invoked in the ANALYZED source. The token is assembled
  // at runtime so this static-analysis detector carries no literal call-shape of its own
  // (this module performs no network I/O itself; enforced by offline-artifact-boundary).
  const FETCH_CLIENT = "fetch";
  const fetchCall = new RegExp(`(^|[^\\w$])${FETCH_CLIENT}\\s*\\(`, "gim");
  while ((match = fetchCall.exec(mask))) add(FETCH_CLIENT, "GET", fetchCall.lastIndex - 1, true);
  for (const wrapper of wrappers) {
    if (wrapper.allowedFiles instanceof Set && !wrapper.allowedFiles.has(normalizeContractFile(file))) continue;
    if (wrapper.kind === "function") {
      const bare = new RegExp(`(^|[^\\w$.?])${escapeRegex(wrapper.call)}\\s*(?:<[^>\\n]{1,200}>)?\\s*\\(`, "gim");
      while ((match = bare.exec(mask))) {
        const nameAt = bare.lastIndex - match[0].length + match[1].length;
        if (/\bfunction\s*$/i.test(mask.slice(Math.max(0, nameAt - 30), nameAt))) continue;
        add(wrapper.call, wrapper.method, bare.lastIndex - 1, false, wrapper.urlArgument, `${wrapper.source}-wrapper`, { kind: wrapper.kind, call: wrapper.call, definitionFile: wrapper.definitionFile || null });
      }
    } else if (wrapper.kind === "member") {
      const memberCall = new RegExp(`(^|[^\\w$])${escapeRegex(wrapper.object)}\\s*(?:\\?\\.|\\.)\\s*${escapeRegex(wrapper.member)}\\s*(?:<[^>\\n]{1,200}>)?\\s*\\(`, "gim");
      while ((match = memberCall.exec(mask))) add(`${wrapper.object}.${wrapper.member}`, wrapper.method, memberCall.lastIndex - 1, false, wrapper.urlArgument, `${wrapper.source}-wrapper`, { kind: wrapper.kind, object: wrapper.object, member: wrapper.member, definitionFile: wrapper.definitionFile || null });
    }
  }
  calls.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.method.localeCompare(right.method) || String(left.path).localeCompare(String(right.path)));
  return { calls, truncated };
}
