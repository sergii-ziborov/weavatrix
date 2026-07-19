export const MAX_ENDPOINT_FILES = 3_000;
export const MAX_ENDPOINTS = 2_000;
export const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "ALL", "ANY"]);

export function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

// Preserve offsets and literals while hiding comments from regex extractors.
export function maskComments(text, { hashComments = false } = {}) {
  const chars = String(text || "").split("");
  let quote = "", escaped = false, lineComment = false, blockComment = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], next = chars[i + 1];
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      else chars[i] = " ";
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { chars[i] = chars[i + 1] = " "; i++; blockComment = false; }
      else if (ch !== "\n" && ch !== "\r") chars[i] = " ";
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && next === "/") { chars[i] = chars[i + 1] = " "; i++; lineComment = true; continue; }
    if (ch === "/" && next === "*") { chars[i] = chars[i + 1] = " "; i++; blockComment = true; continue; }
    if (hashComments && ch === "#") { chars[i] = " "; lineComment = true; }
  }
  return chars.join("");
}

export function handlerName(expr) {
  const source = String(expr || "").trim();
  if (!source || /=>/.test(source) || /^\s*(async\s+)?function\b/.test(source) || /^\s*(?:async\s+)?(?:move\s+)?\|[^|]*\|/.test(source)) return "";
  const turbofish = /(?:^|::)([A-Za-z_][\w]*)\s*::<[\s\S]*>\s*$/.exec(source);
  if (turbofish) return turbofish[1];
  const identifiers = source.match(/[A-Za-z_$][\w$]*/g);
  if (!identifiers) return "";
  const skipped = new Set(["async", "function", "await", "req", "res", "ctx", "request", "response", "next", "return"]);
  for (let i = identifiers.length - 1; i >= 0; i--) if (!skipped.has(identifiers[i])) return identifiers[i];
  return "";
}

export function handlerReference(expr) {
  const source = String(expr || "").trim();
  if (!source || /=>/.test(source) || /^\s*(async\s+)?function\b/.test(source)) return "";
  const refs = [...source.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+)/g)];
  return refs.length ? refs.at(-1)[1].replace(/\s+/g, "") : "";
}

export const looksLikePath = (path) => typeof path === "string" && /^\/[\w\-./:{}*$?]*$/.test(path) && !path.includes("://");
export const cleanPath = (path) => String(path || "").replace(/\/+$/, "") || "/";
export const normalizedFile = (file) => String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
