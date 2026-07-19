export const HTTP_CONTRACTS_V = 2;
export const HTTP_CONTRACT_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export const HTTP_CONTRACT_DEFAULTS = Object.freeze({
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

export const HTTP_CONTRACT_HARD_LIMITS = Object.freeze({
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

export const endpointId = (value) => value && typeof value === "object" ? value.id : value;

export function normalizeContractFile(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:\//i.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return "";
  const normalized = raw.replace(/^\.\//, "");
  return normalized.split("/").some((part) => !part || part === "." || part === "..") ? "" : normalized;
}

export function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function safeContractName(value, fallback) {
  const text = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(text) ? text : fallback;
}

export function contractLineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor++) if (text.charCodeAt(cursor) === 10) line++;
  return line;
}

export function normalizeHttpContractLimits(input = {}) {
  const result = {};
  for (const key of Object.keys(HTTP_CONTRACT_DEFAULTS)) {
    result[key] = boundedInteger(input[key], HTTP_CONTRACT_DEFAULTS[key], key === "maxImpactDepth" ? 0 : 1, HTTP_CONTRACT_HARD_LIMITS[key]);
  }
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
  return /[\x00-\x1f\x7f]/.test(path) || path.includes("..") ? null : path;
}

export function filesFromGraph(graph) {
  return [...new Set((graph?.nodes || []).map((node) => normalizeContractFile(node?.source_file)).filter(Boolean))].sort();
}
