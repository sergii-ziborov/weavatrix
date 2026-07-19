// Spring MVC/WebFlux endpoint extraction. This stays source-only and deliberately resolves only
// literal annotation paths: inventing values for constants would make an architecture inventory look
// more complete than the evidence permits.
import { maskJavaNonCode } from "./java-source.js";
import { lineNumberAt } from "../util.js";

const SPRING_MAPPING = /@(?:org\.springframework\.web\.bind\.annotation\.)?(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/g;
const SPRING_CONDITION = /@(?:org\.springframework\.boot\.autoconfigure\.condition\.)?(ConditionalOnExpression|ConditionalOnProperty)\b/g;
const REQUEST_METHOD = /\bRequestMethod\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b/g;

const lineAt = lineNumberAt;

function skipTrivia(text, start) {
  let i = start;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function balancedEnd(text, start, open = "(", close = ")") {
  if (text[start] !== open) return start;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i + 1;
  }
  return text.length;
}

function annotationInvocation(text, nameEnd) {
  const start = skipTrivia(text, nameEnd);
  if (text[start] !== "(") return { args: "", end: start };
  const end = balancedEnd(text, start);
  return { args: text.slice(start + 1, Math.max(start + 1, end - 1)), end };
}

function skipAnnotations(text, start) {
  let i = skipTrivia(text, start);
  while (text[i] === "@") {
    const name = /^@[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/.exec(text.slice(i));
    if (!name) break;
    i += name[0].length;
    i = annotationInvocation(text, i).end;
    i = skipTrivia(text, i);
  }
  return i;
}

function stringLiterals(value) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(String(value || "")))) {
    out.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return out;
}

function initializer(args, equalsAt) {
  let i = skipTrivia(args, equalsAt + 1);
  if (args[i] === "{") {
    const end = balancedEnd(args, i, "{", "}");
    return args.slice(i, end);
  }
  if (args[i] === '"') {
    let escaped = false;
    for (let end = i + 1; end < args.length; end++) {
      if (escaped) escaped = false;
      else if (args[end] === "\\") escaped = true;
      else if (args[end] === '"') return args.slice(i, end + 1);
    }
  }
  const comma = args.indexOf(",", i);
  return args.slice(i, comma < 0 ? args.length : comma);
}

function mappingPaths(args) {
  const source = String(args || "");
  const named = /\b(?:path|value)\s*=/g.exec(source);
  if (named) return stringLiterals(initializer(source, source.indexOf("=", named.index)));
  const leading = source.trimStart();
  if (!leading) return [""];
  if (leading[0] === '"' || leading[0] === "{") return stringLiterals(leading);
  // `method=`, `produces=` and friends do not specify a path, so they map the class/method root.
  if (/^(?:method|produces|consumes|headers|params|name)\s*=/.test(leading)) return [""];
  return []; // unresolved positional constant: do not invent a root route
}

function mappingMethods(name, args) {
  if (name !== "RequestMapping") return [name.replace(/Mapping$/, "").toUpperCase()];
  const methods = [];
  let match;
  REQUEST_METHOD.lastIndex = 0;
  while ((match = REQUEST_METHOD.exec(args))) if (!methods.includes(match[1])) methods.push(match[1]);
  return methods.length ? methods : ["ANY"];
}

function namedInitializer(args, name) {
  const source = String(args || "");
  const match = new RegExp(`\\b${name}\\s*=`).exec(source);
  return match ? initializer(source, source.indexOf("=", match.index)) : "";
}

function namedStrings(args, name) {
  return stringLiterals(namedInitializer(args, name));
}

function namedBoolean(args, name, fallback) {
  const value = namedInitializer(args, name).trim();
  if (/^true\b/i.test(value)) return true;
  if (/^false\b/i.test(value)) return false;
  return fallback;
}

function positionalStrings(args) {
  const source = String(args || "");
  const start = source.trimStart()[0];
  return start === '"' || start === "{" ? stringLiterals(initializer(source, -1)) : [];
}

function expressionDefaultActive(expression) {
  const value = String(expression || "").trim();
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  const match = /^\$\{[^{}:]+:(true|false)\}$/i.exec(value);
  return match ? match[1].toLowerCase() === "true" : null;
}

function conditionMetadata(annotation, args) {
  if (annotation === "ConditionalOnExpression") {
    const expression = namedStrings(args, "value")[0] || stringLiterals(args)[0] || "";
    return {
      type: annotation,
      expression,
      defaultActive: expressionDefaultActive(expression),
    };
  }
  const namedProperties = [...namedStrings(args, "name"), ...namedStrings(args, "value")];
  const properties = [...new Set(namedProperties.length ? namedProperties : positionalStrings(args))];
  const matchIfMissing = namedBoolean(args, "matchIfMissing", false);
  return {
    type: annotation,
    prefix: namedStrings(args, "prefix")[0] || "",
    properties,
    havingValue: namedStrings(args, "havingValue")[0] || "",
    matchIfMissing,
    defaultActive: matchIfMissing,
  };
}

function joinPaths(prefix, path) {
  const left = String(prefix || "").trim().replace(/^\/+|\/+$/g, "");
  const right = String(path || "").trim().replace(/^\/+|\/+$/g, "");
  return `/${[left, right].filter(Boolean).join("/")}`.replace(/\/{2,}/g, "/");
}

function declarationAfter(text, start) {
  const declarationStart = skipAnnotations(text, start);
  const bounded = text.slice(declarationStart, declarationStart + 2_500);
  const terminators = [bounded.indexOf("{"), bounded.indexOf(";")].filter((i) => i >= 0);
  const end = terminators.length ? Math.min(...terminators) : bounded.length;
  const head = bounded.slice(0, end);
  const classMatch = /\b(class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/.exec(head);
  if (classMatch) {
    const open = bounded.indexOf("{");
    const bodyOpen = open < 0 ? -1 : declarationStart + open;
    return { kind: "class", name: classMatch[2], start: declarationStart, bodyOpen, bodyClose: bodyOpen < 0 ? text.length : balancedEnd(text, bodyOpen, "{", "}") };
  }
  const methodMatch = /\b([A-Za-z_$][\w$]*)\s*\(/.exec(head);
  return methodMatch ? { kind: "method", name: methodMatch[1], start: declarationStart } : { kind: "unknown", name: "", start: declarationStart };
}

export function extractSpringEndpoints(text, file) {
  if (!/\.java$/i.test(file)) return [];
  const code = maskJavaNonCode(text);
  if (!/@(?:[\w$]+\.)*(?:Request|Get|Post|Put|Patch|Delete)Mapping\b/.test(code)) return [];
  const mappings = [];
  let match;
  SPRING_MAPPING.lastIndex = 0;
  while ((match = SPRING_MAPPING.exec(code))) {
    const invocation = annotationInvocation(text, SPRING_MAPPING.lastIndex);
    const declaration = declarationAfter(code, invocation.end);
    mappings.push({
      annotation: match[1],
      args: invocation.args,
      index: match.index,
      line: lineAt(text, match.index),
      declaration,
    });
    SPRING_MAPPING.lastIndex = Math.max(SPRING_MAPPING.lastIndex, invocation.end);
  }
  const conditions = [];
  SPRING_CONDITION.lastIndex = 0;
  while ((match = SPRING_CONDITION.exec(code))) {
    const invocation = annotationInvocation(text, SPRING_CONDITION.lastIndex);
    const declaration = declarationAfter(code, invocation.end);
    conditions.push({
      index: match.index,
      line: lineAt(text, match.index),
      declaration,
      ...conditionMetadata(match[1], invocation.args),
    });
    SPRING_CONDITION.lastIndex = Math.max(SPRING_CONDITION.lastIndex, invocation.end);
  }

  const classMappings = mappings
    .filter((item) => item.declaration.kind === "class")
    .map((item) => ({ ...item, paths: mappingPaths(item.args) }));
  const out = [];
  for (const item of mappings) {
    if (item.declaration.kind !== "method") continue;
    const owner = classMappings
      .filter((candidate) => candidate.declaration.bodyOpen >= 0
        && item.index > candidate.declaration.bodyOpen
        && item.index < candidate.declaration.bodyClose)
      .sort((a, b) => b.declaration.bodyOpen - a.declaration.bodyOpen)[0];
    if (owner && !owner.paths.length) continue; // unresolved class prefix makes the full route unknowable
    const prefixes = owner?.paths?.length ? owner.paths : [""];
    const paths = mappingPaths(item.args);
    if (!paths.length) continue; // literal path was requested but could not be resolved
    const activationConditions = conditions.filter((condition) => condition.declaration.start === item.declaration.start
      || (owner && condition.declaration.start === owner.declaration.start));
    const activation = activationConditions.length
      ? {
          conditional: true,
          defaultActive: activationConditions.some((condition) => condition.defaultActive === false)
            ? false
            : activationConditions.every((condition) => condition.defaultActive === true) ? true : null,
          conditions: activationConditions.map(({ declaration: _declaration, index: _index, ...condition }) => condition),
        }
      : {};
    for (const method of mappingMethods(item.annotation, item.args)) {
      for (const prefix of prefixes) for (const path of paths) {
        out.push({ method, path: joinPaths(prefix, path), handler: item.declaration.name, file, line: item.line, ...activation });
      }
    }
  }
  return out;
}
