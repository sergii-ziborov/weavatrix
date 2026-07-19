import { posix } from "node:path";
import { cleanPath, lineAt, maskComments } from "./common.js";

const JS_ROUTE_EXTENSIONS = [".js", ".ts", ".tsx", ".jsx", ".cjs", ".mjs"];

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
        return { args, end: index + 1 };
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
    const parsed = callArguments(scanText, scanText.indexOf("(", match.index));
    if (!parsed) continue;
    useCall.lastIndex = parsed.end;
    const args = parsed.args.filter(Boolean);
    if (!args.length) continue;
    const literal = /^(["'`])(\/[^"'`]*)\1$/.exec(args[0]);
    const mountPath = literal ? cleanPath(literal[2]) : "/";
    const identifier = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)?$/.exec(args.at(-1) || "")?.[1];
    const child = resolveImportedFile(file, identifier ? bindings.get(identifier) : null, availableFiles);
    if (child && child !== file) mounts.push({ parent: file, child, path: mountPath, line: lineAt(text, match.index) });
  }
  return mounts;
}

export function joinEndpointPath(base, route) {
  const left = cleanPath(base || "/");
  const right = cleanPath(route || "/");
  if (left === "/") return right;
  if (right === "/") return left;
  return cleanPath(`${left}/${right.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/"));
}

export function mountedBasePaths(files, sources) {
  const incoming = new Map();
  const mounts = [];
  const available = new Set(files);
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
    if (!parents.length) return [{ path: "", chain: [] }];
    const paths = [];
    for (const mount of parents) {
      for (const base of resolve(mount.parent, new Set(stack).add(file))) {
        const path = joinEndpointPath(base.path, mount.path);
        const key = `${path}\0${base.chain.map((item) => `${item.file}:${item.line}:${item.path}`).join("|")}\0${mount.parent}:${mount.line}:${mount.path}`;
        if (!paths.some((item) => item.key === key)) paths.push({ key, path, chain: [...base.chain, { file: mount.parent, line: mount.line, path: mount.path, child: mount.child }] });
        if (paths.length >= 32) break;
      }
      if (paths.length >= 32) break;
    }
    const result = paths.length ? paths.map(({ key: _key, ...item }) => item) : [{ path: "", chain: [] }];
    cache.set(file, result);
    return result;
  };
  return { paths: new Map(files.map((file) => [file, resolve(file)])), mounts };
}
