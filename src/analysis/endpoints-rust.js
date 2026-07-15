const RUST_ROUTE_METHOD = "get|post|put|patch|delete|head|options|trace|connect|any";

// Find a call's closing parenthesis without mistaking parens inside strings for syntax. This is deliberately
// small (not a Rust parser), but keeps route-handler expressions bounded instead of using a cross-statement
// regex that could turn an unrelated function call into a route.
function closingParen(text, openAt) {
  let depth = 0, quote = "", escaped = false, blockComment = 0;
  for (let i = openAt; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (blockComment) {
      if (ch === "/" && text[i + 1] === "*") { blockComment++; i++; }
      else if (ch === "*" && text[i + 1] === "/") { blockComment--; i++; }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i + 2);
      if (newline < 0) return -1;
      i = newline;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") { blockComment = 1; i++; continue; }
    if (ch === '"') { quote = ch; continue; }
    if (ch === "'") {
      // Skip a Rust character literal, but do not mistake a lifetime (`'a`) for an unterminated string.
      const char = /^'(?:\\.|[^\\'\r\n])'/.exec(text.slice(i));
      if (char) { i += char[0].length - 1; continue; }
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

// Parse axum's MethodRouter expression, including direct method chains:
//   get(list).post(create) / axum::routing::get(show).delete(remove)
// Calls inside a handler closure are not scanned and therefore cannot become fake endpoint methods.
function axumRoutes(expr) {
  const found = [];
  let rest = String(expr || ""), offset = 0;
  const firstRe = new RegExp(`^\\s*(?:(?:axum\\s*::\\s*)?routing\\s*::\\s*)?(${RUST_ROUTE_METHOD})\\s*\\(`, "i");
  let match = firstRe.exec(rest);
  if (!match) return found;

  while (match) {
    const openAt = offset + match.index + match[0].lastIndexOf("(");
    const closeAt = closingParen(expr, openAt);
    if (closeAt < 0) break;
    found.push({ method: match[1], handler: expr.slice(openAt + 1, closeAt), index: openAt });
    offset = closeAt + 1;
    rest = expr.slice(offset);
    match = new RegExp(`^\\s*\\.\\s*(${RUST_ROUTE_METHOD})\\s*\\(`, "i").exec(rest);
  }
  return found;
}

// Actix's builder form is structurally distinct from axum and from HTTP clients:
//   web::get().to(handler) / actix_web::web::post().to(handler)
function actixRoutes(expr) {
  const found = [];
  const re = new RegExp(`(?:actix_web\\s*::\\s*)?web\\s*::\\s*(${RUST_ROUTE_METHOD})\\s*\\(\\s*\\)\\s*\\.\\s*to\\s*\\(`, "gi");
  let match;
  while ((match = re.exec(expr))) {
    const openAt = re.lastIndex - 1;
    const closeAt = closingParen(expr, openAt);
    if (closeAt < 0) continue;
    found.push({ method: match[1], handler: expr.slice(openAt + 1, closeAt), index: match.index });
    re.lastIndex = closeAt + 1;
  }
  return found;
}

export function extractRustEndpoints(text, add) {
  let match;

  // Axum and actix both expose a path-first `.route(path, ...)` builder. Requiring either an axum
  // MethodRouter or actix's web::<method>().to(...) avoids treating arbitrary Rust APIs named `route` as HTTP.
  const routeRe = /\.\s*route\s*\(\s*"(\/(?:\\.|[^"\\])*)"\s*,/g;
  while ((match = routeRe.exec(text))) {
    const openAt = text.indexOf("(", match.index);
    const closeAt = closingParen(text, openAt);
    if (closeAt < 0) continue;
    const exprStart = routeRe.lastIndex;
    const expr = text.slice(exprStart, closeAt);
    const routes = [...axumRoutes(expr), ...actixRoutes(expr)];
    for (const route of routes) add(route.method, match[1], route.handler, exprStart + route.index);
    routeRe.lastIndex = closeAt + 1;
  }

  // actix `web::resource(path)` associates several method routes with one path.
  const resourceRe = /(?:actix_web\s*::\s*)?web\s*::\s*resource\s*\(\s*"(\/(?:\\.|[^"\\])*)"\s*\)/g;
  while ((match = resourceRe.exec(text))) {
    const tail = text.slice(resourceRe.lastIndex);
    const nextResource = tail.search(/(?:actix_web\s*::\s*)?web\s*::\s*resource\s*\(/);
    const semicolon = text.indexOf(";", resourceRe.lastIndex);
    let end = Math.min(text.length, resourceRe.lastIndex + 4000);
    if (nextResource >= 0) end = Math.min(end, resourceRe.lastIndex + nextResource);
    if (semicolon >= 0) end = Math.min(end, semicolon);
    const chain = text.slice(resourceRe.lastIndex, end);
    for (const route of actixRoutes(chain)) add(route.method, match[1], route.handler, resourceRe.lastIndex + route.index);
  }

  // Actix attribute macros. The route macro can declare more than one method for the same handler.
  const macroRe = new RegExp(`#\\s*\\[\\s*(?:(?:actix_web|actix)\\s*::\\s*)?(${RUST_ROUTE_METHOD})\\s*\\(\\s*"(\\/(?:\\\\.|[^"\\\\])*)"(?:\\s*,[^\\]]*)?\\s*\\)\\s*\\]`, "gi");
  while ((match = macroRe.exec(text))) {
    const after = text.slice(macroRe.lastIndex, macroRe.lastIndex + 600);
    const fn = /\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/.exec(after);
    add(match[1], match[2], fn ? fn[1] : "", match.index);
  }

  const multiMacroRe = /#\s*\[\s*(?:(?:actix_web|actix)\s*::\s*)?route\s*\(\s*"(\/(?:\\.|[^"\\])*)"([\s\S]*?)\)\s*\]/gi;
  while ((match = multiMacroRe.exec(text))) {
    const after = text.slice(multiMacroRe.lastIndex, multiMacroRe.lastIndex + 600);
    const fn = /\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/.exec(after);
    const methodRe = /\bmethod\s*=\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)"/gi;
    let method;
    while ((method = methodRe.exec(match[2]))) add(method[1], match[1], fn ? fn[1] : "", match.index);
  }
}
