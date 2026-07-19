import { safeRead } from "../../util.js";
import { createRepoBoundary } from "../../repo-path.js";
import { MAX_ENDPOINT_FILES, MAX_ENDPOINTS, normalizedFile } from "./common.js";
import { extractEndpointsFromText, nextRoutePath } from "./extract.js";
import { joinEndpointPath, mountedBasePaths } from "./mounts.js";

const normParamKey = (path) => String(path).replace(/\{([^/}]+)\}/g, ":$1");
const sortEndpoints = (left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method);

function preferEndpoint(candidate, current) {
  if (Boolean(candidate.handler) !== Boolean(current.handler)) return Boolean(candidate.handler);
  return Number(candidate.path.includes("{")) < Number(current.path.includes("{"));
}

export function analyzeEndpointInventory(repoPath, codeFiles) {
  const files = (codeFiles || []).slice(0, MAX_ENDPOINT_FILES);
  const byKey = new Map();
  const declarations = new Map();
  const boundary = createRepoBoundary(repoPath);
  const sources = new Map();
  const eligibleFiles = [];
  for (const file of files) {
    const relative = normalizedFile(file.path || file);
    if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java)$/i.test(relative)) continue;
    const resolved = boundary.resolve(relative);
    if (!resolved.ok) continue;
    sources.set(relative, safeRead(resolved.path) || "");
    eligibleFiles.push(relative);
  }
  const mountAnalysis = mountedBasePaths(eligibleFiles, sources);
  let truncated = false;
  for (const relative of eligibleFiles) {
    const text = sources.get(relative);
    const routeSignal = /["'`]\/|\.(?:get|post|put|patch|delete)\s*\(|HandleFunc|@\w*\.?(?:get|post|put|patch|delete)|@(?:[\w$]+\.)*(?:Request|Get|Post|Put|Patch|Delete)Mapping\b/i;
    if (!text || (!nextRoutePath(relative) && !routeSignal.test(text))) continue;
    for (const declaration of extractEndpointsFromText(text, relative)) {
      const declarationKey = `${declaration.file}\0${declaration.line}\0${declaration.method}\0${normParamKey(declaration.path)}`;
      if (!declarations.has(declarationKey)) declarations.set(declarationKey, declaration);
      const bases = mountAnalysis.paths.get(relative) || [{ path: "", chain: [] }];
      for (const base of bases) {
        const path = base.path ? joinEndpointPath(base.path, declaration.path) : declaration.path;
        const endpoint = {
          ...declaration,
          declaredPath: declaration.path,
          path,
          mountState: base.chain.length ? "COMPOSED_STATIC" : "DECLARED_LOCAL",
          confidence: base.chain.length ? "high" : "medium",
          mountChain: base.chain,
          ...(base.path ? { localPath: declaration.path } : {}),
        };
        const key = `${endpoint.method} ${normParamKey(endpoint.path)}`;
        const current = byKey.get(key);
        if (!current || preferEndpoint(endpoint, current)) byKey.set(key, endpoint);
        if (byKey.size >= MAX_ENDPOINTS) { truncated = true; break; }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  const endpoints = [...byKey.values()].sort(sortEndpoints);
  const composed = endpoints.filter((endpoint) => endpoint.mountChain.length).length;
  return {
    endpoints,
    declarations: [...declarations.values()].sort(sortEndpoints),
    mounts: mountAnalysis.mounts,
    stats: {
      scannedFiles: eligibleFiles.length,
      declaredRoutes: declarations.size,
      emittedRoutes: endpoints.length,
      reachableRoutes: composed,
      reachableStaticRoutes: composed,
      composedRoutes: composed,
      localRoutes: endpoints.length - composed,
      localDeclarations: endpoints.length - composed,
      staticMounts: mountAnalysis.mounts.length,
      truncated,
      maxEndpoints: MAX_ENDPOINTS,
    },
  };
}

export function detectEndpoints(repoPath, codeFiles) {
  return analyzeEndpointInventory(repoPath, codeFiles).endpoints;
}
