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

const MAX_FILES = 3000;
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
  const add = (method, path, expr, idx) => {
    const p = cleanPath(path);
    if (!looksLikePath(p)) return;
    const m = String(method || "ANY").toUpperCase();
    if (!HTTP_METHODS.has(m)) return;
    out.push({ method: m, path: p, handler: handlerName(expr), file, line: lineAt(text, idx) });
  };

  // Next.js App Router: the filesystem provides the path and exported HTTP-method functions provide the
  // verbs. No literal route string exists in route.ts, so generic Express/FastAPI regexes cannot see it.
  const nextPath = nextRoutePath(file);
  if (nextPath) {
    const seen = new Set();
    const direct = /\bexport\s+(?:(?:async|declare)\s+)*(?:function\s+|(?:const|let|var)\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    let nm;
    while ((nm = direct.exec(text))) {
      const method = nm[1].toUpperCase();
      if (!seen.has(method)) { seen.add(method); add(method, nextPath, method, nm.index); }
    }
    const lists = /\bexport\s*\{([^}]+)\}/g;
    let lm;
    while ((lm = lists.exec(text))) {
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

  if (rust) extractRustEndpoints(text, add);
  if (java) {
    out.push(...extractSpringEndpoints(text, file));
    return out; // generic JS-style method calls would turn Java HTTP clients into fake server routes
  }

  // ---- object routes: "/path": { GET: fn, POST: fn2 }  or  "/path": handler --------------------
  // find each  "…": {  or  "…": expr,  where the key looks like a path
  const objKeyRe = /(["'`])(\/[^"'`]*)\1\s*:\s*(\{)?/g;
  let m;
  while ((m = objKeyRe.exec(text))) {
    const path = m[2], keyIdx = m.index;
    if (m[3]) {
      // object of METHOD: handler — scan to the matching close brace (routes objects are shallow)
      let i = objKeyRe.lastIndex, depth = 1;
      const start = i;
      while (i < text.length && depth > 0) { const c = text[i]; if (c === "{") depth++; else if (c === "}") depth--; i++; }
      const body = text.slice(start, i - 1);
      objKeyRe.lastIndex = i;
      if (OPENAPI_BLOCK.test(body)) continue; // documentation, not a route table
      const methodRe = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s*:\s*([^,\n}]+)/gi;
      let mm;
      while ((mm = methodRe.exec(body))) add(mm[1], path, mm[2], keyIdx);
    } else {
      // "/path": handlerExpr — a direct handler (any method); grab up to the next , or }
      const tail = text.slice(objKeyRe.lastIndex, objKeyRe.lastIndex + 200);
      const em = /^([^,\n}]+)/.exec(tail);
      if (em && !/^\s*\{/.test(em[1])) add("ANY", path, em[1], keyIdx);
    }
  }

  // ---- method-call routes: app.get("/path", handler) / router.post(...) / r.GET(...) ------------
  // (?<!@) so a DECORATOR like @router.get("/x") isn't also caught here (handler-less); decorators are
  // handled separately below where the handler is the following def. The CALLER is captured so we can reject
  // CLIENT HTTP calls (axios.get("/api/users"), http.get(url), apiClient.post(...)) — those are requests in
  // FRONTEND code, not server routes. A server route also REQUIRES a handler arg (an identifier/function),
  // so a bare `client.get("/x")` or one whose 2nd arg is a config object literal `{…}` is skipped.
  const callRe = /(?<!@)\b([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(["'`])(\/[^"'`]*)\3\s*(?:,\s*([\s\S]{0,160}?))?\)/gi;
  while ((m = callRe.exec(text))) {
    const caller = m[1], arg2 = String(m[5] || "").trim();
    if (HTTP_CLIENT_CALLER.test(caller)) continue;          // axios/http/fetch/apiClient… → a client request
    if (!arg2 || arg2[0] === "{") continue;                 // no handler, or a config object → not a route def
    add(m[2], m[4], m[5] || "", m.index);
  }

  // ---- Go net/http: mux.HandleFunc("/path", handler) / http.Handle("/path", h) ------------------
  const goRe = /\.\s*(?:HandleFunc|Handle)\s*\(\s*(["'`])(\/[^"'`]*)\1\s*,\s*([\s\S]{0,120}?)\)/g;
  while ((m = goRe.exec(text))) add("ANY", m[2], m[3], m.index);

  // ---- decorators: @app.get("/path") / @router.post("/path") / @Get("/path") -------------------
  if (py || /\.(ts|js|tsx|jsx|cjs|mjs)$/i.test(file)) {
    const decoRe = /@[\w$]*\.?\s*(get|post|put|patch|delete|head|options)\s*\(\s*(["'`])(\/[^"'`]*)\2/gi;
    while ((m = decoRe.exec(text))) {
      // the handler is the def/function on a following line — best-effort: next def name
      const after = text.slice(decoRe.lastIndex, decoRe.lastIndex + 200);
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
export function detectEndpoints(repoPath, codeFiles) {
  const files = (codeFiles || []).slice(0, MAX_FILES);
  const byKey = new Map();
  const boundary = createRepoBoundary(repoPath);
  for (const f of files) {
    const rel = f.path || f;
    if (!/\.(js|ts|tsx|jsx|cjs|mjs|py|go|rs|java)$/i.test(rel)) continue;
    const resolved = boundary.resolve(rel);
    if (!resolved.ok) continue;
    const text = safeRead(resolved.path);
    if (!text || (!nextRoutePath(rel) && !/["'`]\/|\.(get|post|put|patch|delete)\s*\(|HandleFunc|@\w*\.?(get|post|put|patch|delete)|@(?:[\w$]+\.)*(?:Request|Get|Post|Put|Patch|Delete)Mapping\b/i.test(text))) continue;
    for (const e of extractEndpointsFromText(text, rel.replace(/\\/g, "/"))) {
      const key = `${e.method} ${normParamKey(e.path)}`;
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, e); }
      else if (preferEndpoint(e, prev)) { byKey.set(key, e); }
      if (byKey.size >= 500) return [...byKey.values()].sort(sortEndpoints);
    }
  }
  return [...byKey.values()].sort(sortEndpoints);
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
