// endpoints.js — detect the repo's OWN HTTP API surface (routes it EXPOSES), so the Health tab can
// surface endpoints the way infra towers surface the services a repo TALKS TO. Each endpoint carries a
// best-effort handler NAME so the UI can join it to that method's health (O(n) complexity, criticality,
// coverage). Covers the common shapes across JS/TS, Python, Go and Rust:
//   • object routes (Bun.serve / custom):  "/path": { GET: handler, POST: fn }   |   "/path": handler
//   • method-call routes (Express/Fastify/Koa/Hono/gin/echo):  app.get("/path", handler)
//   • decorators (FastAPI/Flask/NestJS):   @app.get("/path")  /  @Get("/path")
//   • Go net/http:                          mux.HandleFunc("/path", handler)
//   • Rust axum/actix-web:                  .route("/path", get(handler)) / #[get("/path")]
import { safeRead } from "../util.js";
import { createRepoBoundary } from "../repo-path.js";
import { extractRustEndpoints } from "./endpoints-rust.js";
import { extractSpringEndpoints } from "./endpoints-java.js";
import { posix } from "node:path";

const MAX_FILES = 3000;
const MAX_ENDPOINTS = 2000;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "ALL", "ANY"]);
// UNAMBIGUOUS HTTP CLIENTS (make requests) vs servers (define routes) — reject `axios.get("/x")`-style client
// calls in frontend code. Ambiguous names (api/client/service — could be a server router) are NOT listed;
// they're filtered by the handler requirement instead (a client call has no handler / a config object arg).
const HTTP_CLIENT_CALLER = /^(axios|https?|fetch|ky|got|superagent|needle|undici|xhr|\$http|http[Cc]lient|api[Cc]lient|rest[Cc]lient)$/;


// 1-based line of a string index
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

// Regex extractors must never see commented-out routes. Preserve string literals and every source
// offset, but replace comment bodies with spaces so endpoint line numbers still refer to the original
// file. Python `#` comments are enabled only for .py files; Rust attributes such as #[get] stay intact.
function maskComments(text, { hashComments = false } = {}) {
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

// best-effort bare handler name from a value expression: the LAST identifier, unwrapping wrappers like
// executionRoute(queryHandlers.executeQuery) → executeQuery, asyncHandler(fn) → fn, a.b.c → c.
// An INLINE handler (arrow / function literal) has no named method to join to, so it returns "" (the
// UI then shows "inline") — grabbing an identifier out of an arrow body only invents garbage names.
function handlerName(expr) {
  const s = String(expr || "").trim();
  if (!s) return "";
  if (/=>/.test(s) || /^\s*(async\s+)?function\b/.test(s) || /^\s*(?:async\s+)?(?:move\s+)?\|[^|]*\|/.test(s)) return "";
  const turbofish = /(?:^|::)([A-Za-z_][\w]*)\s*::<[\s\S]*>\s*$/.exec(s);
  if (turbofish) return turbofish[1];
  const ids = s.match(/[A-Za-z_$][\w$]*/g);
  if (!ids) return "";
  const SKIP = new Set(["async", "function", "await", "req", "res", "ctx", "request", "response", "next", "return"]);
  for (let i = ids.length - 1; i >= 0; i--) if (!SKIP.has(ids[i])) return ids[i];
  return "";
}

// An OpenAPI / Swagger spec object (e.g. `*.openapi.js` `paths`) documents routes rather than serving
// them — its "handlers" are operation()/spec objects, so treating it as a route table produced fake
// endpoints (handler "operation", {id} params). These keys never appear in a real route/handler table.
const OPENAPI_BLOCK = /\boperationId\b|\bresponses\s*:|\brequestBody\b|\bschemaRef\b|\boperation\s*\(|\bsummary\s*:/;

const looksLikePath = (p) => typeof p === "string" && /^\/[\w\-./:{}*$?]*$/.test(p) && !p.includes("://");
const cleanPath = (p) => String(p || "").replace(/\/+$/, "") || "/";

const JS_ROUTE_EXTENSIONS = [".js", ".ts", ".tsx", ".jsx", ".cjs", ".mjs"];
const normalizedFile = (file) => String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");

function importBindings(text) {
  const bindings = new Map();
  const add = (name, specifier) => {
    if (/^[A-Za-z_$][\w$]*$/.test(name || "") && typeof specifier === "string") bindings.set(name, specifier);
  };
  let match;
  const direct = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s*(["'`])([^"'`]+)\2/g;
  while ((match = direct.exec(text))) add(match[1], match[3]);
  const namespace = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*(["'`])([^"'`]+)\2/g;
  while ((match = namespace.exec(text))) add(match[1], match[3]);
  const named = /\bimport\s*\{([^}]+)\}\s*from\s*(["'`])([^"'`]+)\2/g;
  while ((match = named.exec(text))) {
    for (const item of match[1].split(",")) {
      const binding = /^\s*[A-Za-z_$][\w$]*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(item);
      if (binding) add(binding[1] || item.trim(), match[3]);
    }
  }
  const commonJs = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(["'`])([^"'`]+)\2\s*\)/g;
  while ((match = commonJs.exec(text))) add(match[1], match[3]);
  return bindings;
}

function handlerReference(expr) {
  const s = String(expr || "").trim();
  if (!s || /=>/.test(s) || /^\s*(async\s+)?function\b/.test(s)) return "";
  const refs = [...s.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+)/g)];
  return refs.length ? refs.at(-1)[1].replace(/\s+/g, "") : "";
}

function resolveImportedFile(importer, specifier, availableFiles) {
  if (!specifier?.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const candidates = [base];
  if (!JS_ROUTE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
    for (const extension of JS_ROUTE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of JS_ROUTE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  }
  return candidates.find((candidate) => availableFiles.has(candidate)) || null;
}

function callArguments(text, openParen) {
  let quote = "", escaped = false, depth = 0, start = openParen + 1;
  const args = [];
  for (let index = openParen; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(") { depth++; continue; }
    if (char === ")") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, index).trim());
        return {args, end: index + 1};
      }
      continue;
    }
    if (char === "," && depth === 1) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return null;
}

function routerMounts(text, file, availableFiles) {
  const scanText = maskComments(text);
  const bindings = importBindings(scanText);
  const mounts = [];
  const useCall = /\b[A-Za-z_$][\w$]*\s*\.\s*use\s*\(/g;
  let match;
  while ((match = useCall.exec(scanText))) {
    const openParen = scanText.indexOf("(", match.index);
    const parsed = callArguments(scanText, openParen);
    if (!parsed) continue;
    useCall.lastIndex = parsed.end;
    const args = parsed.args.filter(Boolean);
    if (!args.length) continue;
    const literal = /^(["'`])(\/[^"'`]*)\1$/.exec(args[0]);
    const mountPath = literal ? cleanPath(literal[2]) : "/";
    const childExpression = args.at(-1) || "";
    const identifier = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)?$/.exec(childExpression)?.[1];
    const specifier = identifier ? bindings.get(identifier) : null;
    const child = resolveImportedFile(file, specifier, availableFiles);
    if (child && child !== file) mounts.push({parent: file, child, path: mountPath, line: lineAt(text, match.index)});
  }
  return mounts;
}

function joinEndpointPath(base, route) {
  const left = cleanPath(base || "/");
  const right = cleanPath(route || "/");
  if (left === "/") return right;
  if (right === "/") return left;
  return cleanPath(`${left}/${right.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/"));
}

function mountedBasePaths(files, sources) {
  const available = new Set(files);
  const incoming = new Map();
  const mounts = [];
  for (const file of files) {
    for (const mount of routerMounts(sources.get(file) || "", file, available)) {
      mounts.push(mount);
      if (!incoming.has(mount.child)) incoming.set(mount.child, []);
      incoming.get(mount.child).push(mount);
    }
  }
  const cache = new Map();
  const resolve = (file, stack = new Set()) => {
    if (cache.has(file)) return cache.get(file);
    if (stack.has(file)) return [];
    const parents = incoming.get(file) || [];
    if (!parents.length) return [{path: "", chain: []}];
    const nextStack = new Set(stack).add(file);
    const paths = [];
    for (const mount of parents) {
      for (const base of resolve(mount.parent, nextStack)) {
        const composed = joinEndpointPath(base.path, mount.path);
        const key = `${composed}\0${base.chain.map((item) => `${item.file}:${item.line}:${item.path}`).join("|")}\0${mount.parent}:${mount.line}:${mount.path}`;
        if (!paths.some((item) => item.key === key)) paths.push({
          key,
          path: composed,
          chain: [...base.chain, {file: mount.parent, line: mount.line, path: mount.path, child: mount.child}],
        });
        if (paths.length >= 32) break;
      }
      if (paths.length >= 32) break;
    }
    const result = paths.length ? paths.map(({key, ...item}) => item) : [{path: "", chain: []}];
    cache.set(file, result);
    return result;
  };
  return {
    paths: new Map(files.map((file) => [file, resolve(file)])),
    mounts,
  };
}

export function nextRoutePath(file) {
  const parts = String(file || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!/^route\.[cm]?[jt]s$/i.test(parts.at(-1) || "")) return "";
  const appAt = parts.lastIndexOf("app");
  if (appAt < 0) return "";
  const route = [];
  for (let segment of parts.slice(appAt + 1, -1)) {
    if (!segment || /^\([^)]*\)$/.test(segment) || segment.startsWith("@")) continue; // route groups / parallel slots
    segment = segment.replace(/^\((?:\.{1,3})\)/, "");                    // intercepting-route marker
    let m;
    if ((m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment))) segment = `*${m[1]}?`;
    else if ((m = /^\[\.\.\.([^\]]+)\]$/.exec(segment))) segment = `*${m[1]}`;
    else if ((m = /^\[([^\]]+)\]$/.exec(segment))) segment = `:${m[1]}`;
    if (segment) route.push(segment);
  }
  return `/${route.join("/")}`;
}

export function extractEndpointsFromText(text, file) {
  const out = [];
  const py = /\.py$/i.test(file);
  const rust = /\.rs$/i.test(file);
  const java = /\.java$/i.test(file);
  const scanText = maskComments(text, { hashComments: py });
  const add = (method, path, expr, idx) => {
    const p = cleanPath(path);
    if (!looksLikePath(p)) return;
    const m = String(method || "ANY").toUpperCase();
    if (!HTTP_METHODS.has(m)) return;
    const handler = handlerName(expr);
    const handlerRef = handlerReference(expr);
    out.push({ method: m, path: p, handler, ...(handlerRef ? {handlerRef} : {}), file, line: lineAt(text, idx) });
  };

  // Next.js App Router: the filesystem provides the path and exported HTTP-method functions provide the
  // verbs. No literal route string exists in route.ts, so generic Express/FastAPI regexes cannot see it.
  const nextPath = nextRoutePath(file);
  if (nextPath) {
    const seen = new Set();
    const direct = /\bexport\s+(?:(?:async|declare)\s+)*(?:function\s+|(?:const|let|var)\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    let nm;
    while ((nm = direct.exec(scanText))) {
      const method = nm[1].toUpperCase();
      if (!seen.has(method)) { seen.add(method); add(method, nextPath, method, nm.index); }
    }
    const lists = /\bexport\s*\{([^}]+)\}/g;
    let lm;
    while ((lm = lists.exec(scanText))) {
      for (const item of lm[1].split(",")) {
        const mm = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))?\s*$/.exec(item);
        if (!mm) continue;
        if (!mm[2] && !HTTP_METHODS.has(mm[1])) continue;
        const method = String(mm[2] || mm[1]).toUpperCase();
        if (!HTTP_METHODS.has(method)) continue;
        if (!seen.has(method)) { seen.add(method); add(method, nextPath, mm[1], lm.index); }
      }
    }
  }

  if (rust) extractRustEndpoints(scanText, add);
  if (java) {
    out.push(...extractSpringEndpoints(scanText, file));
    return out; // generic JS-style method calls would turn Java HTTP clients into fake server routes
  }

  // ---- object routes: "/path": { GET: fn, POST: fn2 }  or  "/path": handler --------------------
  // find each  "…": {  or  "…": expr,  where the key looks like a path
  const objKeyRe = /(["'`])(\/[^"'`]*)\1\s*:\s*(\{)?/g;
  let m;
  while ((m = objKeyRe.exec(scanText))) {
    const path = m[2], keyIdx = m.index;
    if (m[3]) {
      // object of METHOD: handler — scan to the matching close brace (routes objects are shallow)
      let i = objKeyRe.lastIndex, depth = 1;
      const start = i;
      while (i < scanText.length && depth > 0) { const c = scanText[i]; if (c === "{") depth++; else if (c === "}") depth--; i++; }
      const body = scanText.slice(start, i - 1);
      objKeyRe.lastIndex = i;
      if (OPENAPI_BLOCK.test(body)) continue; // documentation, not a route table
      const methodRe = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s*:\s*([^,\n}]+)/gi;
      let mm;
      while ((mm = methodRe.exec(body))) add(mm[1], path, mm[2], keyIdx);
    } else {
      // "/path": handlerExpr — a direct handler (any method); grab up to the next , or }
      const tail = scanText.slice(objKeyRe.lastIndex, objKeyRe.lastIndex + 200);
      const em = /^([^,\n}]+)/.exec(tail);
      // A string/number/array value is an ordinary path/name lookup, not an executable handler.
      if (em && !/^\s*(?:\{|["'`\[]|[-+]?\d|true\b|false\b|null\b|undefined\b)/i.test(em[1])) add("ANY", path, em[1], keyIdx);
    }
  }

  // ---- method-call routes: app.get("/path", handler) / router.post(...) / r.GET(...) ------------
  // (?<!@) so a DECORATOR like @router.get("/x") isn't also caught here (handler-less); decorators are
  // handled separately below where the handler is the following def. The CALLER is captured so we can reject
  // CLIENT HTTP calls (axios.get("/api/users"), http.get(url), apiClient.post(...)) — those are requests in
  // FRONTEND code, not server routes. A server route also REQUIRES a handler arg (an identifier/function),
  // so a bare `client.get("/x")` or one whose 2nd arg is a config object literal `{…}` is skipped.
  const callRe = /(?<!@)\b([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(["'`])(\/[^"'`]*)\3\s*(?:,\s*([\s\S]{0,160}?))?\)/gi;
  while ((m = callRe.exec(scanText))) {
    const caller = m[1], arg2 = String(m[5] || "").trim();
    if (HTTP_CLIENT_CALLER.test(caller)) continue;          // axios/http/fetch/apiClient… → a client request
    if (!arg2 || arg2[0] === "{") continue;                 // no handler, or a config object → not a route def
    add(m[2], m[4], m[5] || "", m.index);
  }

  // ---- Go net/http: mux.HandleFunc("/path", handler) / http.Handle("/path", h) ------------------
  const goRe = /\.\s*(?:HandleFunc|Handle)\s*\(\s*(["'`])(\/[^"'`]*)\1\s*,\s*([\s\S]{0,120}?)\)/g;
  while ((m = goRe.exec(scanText))) add("ANY", m[2], m[3], m.index);

  // ---- decorators: @app.get("/path") / @router.post("/path") / @Get("/path") -------------------
  if (py || /\.(ts|js|tsx|jsx|cjs|mjs)$/i.test(file)) {
    const decoRe = /@[\w$]*\.?\s*(get|post|put|patch|delete|head|options)\s*\(\s*(["'`])(\/[^"'`]*)\2/gi;
    while ((m = decoRe.exec(scanText))) {
      // the handler is the def/function on a following line — best-effort: next def name
      const after = scanText.slice(decoRe.lastIndex, decoRe.lastIndex + 200);
      const fn = /\b(?:def|async\s+def|function|const|export\s+function)\s+([A-Za-z_$][\w$]*)/.exec(after);
      add(m[1], m[3], fn ? fn[1] : "", m.index);
    }
  }

  return out;
}

// `{id}` (OpenAPI) and `:id` (JS routers) are the SAME route — normalize for dedup so a real handler
// route isn't listed twice alongside its doc counterpart.
const normParamKey = (p) => String(p).replace(/\{([^/}]+)\}/g, ":$1");

// Detect endpoints across the repo's code files (from the graph's file nodes, or a caller-supplied list
// of {path, full}). Deduped by method+normalized-path; on a collision the entry with a resolvable
// handler (and `:param` display) wins. Capped. Returns [{method, path, handler, file, line}].
export function analyzeEndpointInventory(repoPath, codeFiles) {
  const files = (codeFiles || []).slice(0, MAX_FILES);
  const byKey = new Map();
  const declarations = new Map();
  const boundary = createRepoBoundary(repoPath);
  const sources = new Map();
  const eligibleFiles = [];
  for (const f of files) {
    const rel = normalizedFile(f.path || f);
    if (!/\.(js|ts|tsx|jsx|cjs|mjs|py|go|rs|java)$/i.test(rel)) continue;
    const resolved = boundary.resolve(rel);
    if (!resolved.ok) continue;
    const text = safeRead(resolved.path);
    sources.set(rel, text || "");
    eligibleFiles.push(rel);
  }
  const mountAnalysis = mountedBasePaths(eligibleFiles, sources);
  let truncated = false;
  for (const rel of eligibleFiles) {
    const text = sources.get(rel);
    if (!text || (!nextRoutePath(rel) && !/["'`]\/|\.(get|post|put|patch|delete)\s*\(|HandleFunc|@\w*\.?(get|post|put|patch|delete)|@(?:[\w$]+\.)*(?:Request|Get|Post|Put|Patch|Delete)Mapping\b/i.test(text))) continue;
    for (const e of extractEndpointsFromText(text, rel.replace(/\\/g, "/"))) {
      const declarationKey = `${e.file}\0${e.line}\0${e.method}\0${normParamKey(e.path)}`;
      if (!declarations.has(declarationKey)) declarations.set(declarationKey, e);
      const bases = mountAnalysis.paths.get(rel) || [{path: "", chain: []}];
      for (const base of bases) {
        const composed = base.path ? joinEndpointPath(base.path, e.path) : e.path;
        const endpoint = {
          ...e,
          declaredPath: e.path,
          path: composed,
          mountState: base.chain.length ? "COMPOSED_STATIC" : "DECLARED_LOCAL",
          confidence: base.chain.length ? "high" : "medium",
          mountChain: base.chain,
          ...(base.path ? {localPath: e.path} : {}),
        };
        const key = `${endpoint.method} ${normParamKey(endpoint.path)}`;
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, endpoint); }
        else if (preferEndpoint(endpoint, prev)) { byKey.set(key, endpoint); }
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

// true when candidate `a` is a better representative of a route than the already-kept `b`:
// a resolvable handler beats none; failing that, a `:param` path beats a `{param}` one.
function preferEndpoint(a, b) {
  const ha = a.handler ? 1 : 0, hb = b.handler ? 1 : 0;
  if (ha !== hb) return ha > hb;
  const ca = a.path.includes("{") ? 1 : 0, cb = b.path.includes("{") ? 1 : 0;
  return ca < cb;
}

function sortEndpoints(a, b) {
  return a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
}
