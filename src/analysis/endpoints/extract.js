import { extractRustEndpoints } from "../endpoints-rust.js";
import { extractSpringEndpoints } from "../endpoints-java.js";
import { HTTP_METHODS, cleanPath, handlerName, handlerReference, lineAt, looksLikePath, maskComments } from "./common.js";

const HTTP_CLIENT_CALLER = /^(axios|https?|fetch|ky|got|superagent|needle|undici|xhr|\$http|http[Cc]lient|api[Cc]lient|rest[Cc]lient)$/;
const OPENAPI_BLOCK = /\boperationId\b|\bresponses\s*:|\brequestBody\b|\bschemaRef\b|\boperation\s*\(|\bsummary\s*:/;

export function nextRoutePath(file) {
  const parts = String(file || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!/^route\.[cm]?[jt]s$/i.test(parts.at(-1) || "")) return "";
  const appAt = parts.lastIndexOf("app");
  if (appAt < 0) return "";
  const route = [];
  for (let segment of parts.slice(appAt + 1, -1)) {
    if (!segment || /^\([^)]*\)$/.test(segment) || segment.startsWith("@")) continue;
    segment = segment.replace(/^\((?:\.{1,3})\)/, "");
    let match;
    if ((match = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment))) segment = `*${match[1]}?`;
    else if ((match = /^\[\.\.\.([^\]]+)\]$/.exec(segment))) segment = `*${match[1]}`;
    else if ((match = /^\[([^\]]+)\]$/.exec(segment))) segment = `:${match[1]}`;
    if (segment) route.push(segment);
  }
  return `/${route.join("/")}`;
}

export function extractEndpointsFromText(text, file) {
  const out = [];
  const py = /\.py$/i.test(file), rust = /\.rs$/i.test(file), java = /\.java$/i.test(file);
  const scanText = maskComments(text, { hashComments: py });
  const add = (method, path, expr, index) => {
    const normalizedPath = cleanPath(path);
    const normalizedMethod = String(method || "ANY").toUpperCase();
    if (!looksLikePath(normalizedPath) || !HTTP_METHODS.has(normalizedMethod)) return;
    const handler = handlerName(expr);
    const handlerRef = handlerReference(expr);
    out.push({ method: normalizedMethod, path: normalizedPath, handler, ...(handlerRef ? { handlerRef } : {}), file, line: lineAt(text, index) });
  };

  const nextPath = nextRoutePath(file);
  if (nextPath) {
    const seen = new Set();
    const direct = /\bexport\s+(?:(?:async|declare)\s+)*(?:function\s+|(?:const|let|var)\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    let match;
    while ((match = direct.exec(scanText))) {
      const method = match[1].toUpperCase();
      if (!seen.has(method)) { seen.add(method); add(method, nextPath, method, match.index); }
    }
    const lists = /\bexport\s*\{([^}]+)\}/g;
    while ((match = lists.exec(scanText))) {
      for (const item of match[1].split(",")) {
        const methodMatch = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))?\s*$/.exec(item);
        if (!methodMatch || (!methodMatch[2] && !HTTP_METHODS.has(methodMatch[1]))) continue;
        const method = String(methodMatch[2] || methodMatch[1]).toUpperCase();
        if (HTTP_METHODS.has(method) && !seen.has(method)) { seen.add(method); add(method, nextPath, methodMatch[1], match.index); }
      }
    }
  }

  if (rust) extractRustEndpoints(scanText, add);
  if (java) {
    out.push(...extractSpringEndpoints(scanText, file));
    return out;
  }

  const objKey = /(["'`])(\/[^"'`]*)\1\s*:\s*(\{)?/g;
  let match;
  while ((match = objKey.exec(scanText))) {
    const path = match[2], keyIndex = match.index;
    if (match[3]) {
      let cursor = objKey.lastIndex, depth = 1;
      const start = cursor;
      while (cursor < scanText.length && depth > 0) {
        if (scanText[cursor] === "{") depth++;
        else if (scanText[cursor] === "}") depth--;
        cursor++;
      }
      const body = scanText.slice(start, cursor - 1);
      objKey.lastIndex = cursor;
      if (OPENAPI_BLOCK.test(body)) continue;
      const methodEntry = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s*:\s*([^,\n}]+)/gi;
      let entry;
      while ((entry = methodEntry.exec(body))) add(entry[1], path, entry[2], keyIndex);
    } else {
      const expression = /^([^,\n}]+)/.exec(scanText.slice(objKey.lastIndex, objKey.lastIndex + 200));
      if (expression && !/^\s*(?:\{|["'`\[]|[-+]?\d|true\b|false\b|null\b|undefined\b)/i.test(expression[1])) add("ANY", path, expression[1], keyIndex);
    }
  }

  const call = /(?<!@)\b([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(["'`])(\/[^"'`]*)\3\s*(?:,\s*([\s\S]{0,160}?))?\)/gi;
  while ((match = call.exec(scanText))) {
    const handler = String(match[5] || "").trim();
    if (!HTTP_CLIENT_CALLER.test(match[1]) && handler && handler[0] !== "{") add(match[2], match[4], match[5], match.index);
  }

  const go = /\.\s*(?:HandleFunc|Handle)\s*\(\s*(["'`])(\/[^"'`]*)\1\s*,\s*([\s\S]{0,120}?)\)/g;
  while ((match = go.exec(scanText))) add("ANY", match[2], match[3], match.index);

  if (py || /\.(?:[cm]?[jt]sx?)$/i.test(file)) {
    const decorator = /@[\w$]*\.?\s*(get|post|put|patch|delete|head|options)\s*\(\s*(["'`])(\/[^"'`]*)\2/gi;
    while ((match = decorator.exec(scanText))) {
      const after = scanText.slice(decorator.lastIndex, decorator.lastIndex + 200);
      const fn = /\b(?:def|async\s+def|function|const|export\s+function)\s+([A-Za-z_$][\w$]*)/.exec(after);
      add(match[1], match[3], fn ? fn[1] : "", match.index);
    }
  }
  return out;
}
