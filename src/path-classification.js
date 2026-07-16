// Repository-semantic path classification. Unlike `.weavatrixignore`, this layer never removes a
// file from the graph: it labels non-product surfaces so health/clone/test-reachability tools can
// suppress noise while still explaining the exact rule that matched.
import { openSync, closeSync, readSync, readFileSync, statSync } from "node:fs";
import { createRepoBoundary } from "./repo-path.js";

export const PATH_CLASS_NAMES = Object.freeze(["test", "e2e", "generated", "mock", "story", "docs", "benchmark", "temp"]);
const PATH_CLASS_SET = new Set(PATH_CLASS_NAMES);
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RULES_PER_CLASS = 64;
const MAX_RULE_LENGTH = 256;
const HEADER_BYTES = 8192;

const normalizePath = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
const escapeRegex = (value) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

function compileGlob(input) {
  let pattern = String(input || "").trim().replace(/\\/g, "/");
  if (!pattern || pattern.length > MAX_RULE_LENGTH || pattern.includes("\0") || pattern.split("/").includes("..")) return null;
  const anchored = pattern.startsWith("/");
  const directory = pattern.endsWith("/");
  pattern = pattern.replace(/^\/+|\/+$/g, "");
  if (!pattern) return null;
  let body = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      body += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += escapeRegex(char);
  }
  const prefix = anchored ? "^" : "(?:^|/)";
  const suffix = directory ? "(?:/.*)?$" : "$";
  return new RegExp(`${prefix}${body}${suffix}`, "i");
}

const DEFAULT_RULES = [
  {
    category: "e2e",
    pattern: "test-e2e, e2e, Cypress, Playwright or acceptance/integration test roots",
    regex: /(^|\/)(?:test-e2e|e2e|cypress|playwright|tests?[-_](?:e2e|integration|acceptance)|(?:e2e|integration|acceptance)[-_]tests?)(\/|$)|\.(?:e2e|cy)\.[^.\/]+$/i,
  },
  {
    category: "test",
    pattern: "test/spec roots and conventional test filenames",
    regex: /(^|\/)(?:__tests?__|tests?|spec)(\/|$)|\.(?:test|itest|spec)\.[^.\/]+$|_test\.go$|(^|\/)test_[^/]*\.py$/i,
  },
  {
    category: "generated",
    pattern: "generated/OpenAPI output path",
    regex: /(^|\/)(?:generated|gen|openapi[-_]?generated|generated[-_]?client|api[-_]?client[-_]?generated)(\/|$)/i,
  },
  {
    category: "generated",
    pattern: "conventional build output path",
    regex: /(^|\/)(?:dist|build|out|coverage|\.next)(\/|$)/i,
  },
  {
    category: "mock",
    pattern: "mock/fixture path or mockData filename",
    regex: /(^|\/)(?:__mocks__|mocks?|fixtures?|__fixtures__)(\/|$)|(^|\/)(?:mock[-_.]?data|test[-_.]?data|fake[-_.]?data)\.[^.\/]+$/i,
  },
  {
    category: "story",
    pattern: "Storybook story",
    regex: /(^|\/)\.storybook(\/|$)|\.stories?\.[^.\/]+$/i,
  },
  {
    category: "docs",
    pattern: "documentation path or prose file",
    regex: /(^|\/)(?:docs?|documentation)(\/|$)|\.(?:md|markdown|mdx|rst|adoc)$/i,
  },
  {
    category: "benchmark",
    pattern: "benchmark/benchmarks root",
    regex: /(^|\/)benchmarks?(\/|$)/i,
  },
  {
    category: "temp",
    pattern: "__temp working/generated root",
    regex: /(^|\/)__temp(\/|$)/i,
  },
];

const GENERATED_HEADER_RE = /(?:@generated\b|auto[- ]generated\b|generated\s+(?:code|file|client).*do not edit|do not edit.*generated|openapi generator)/i;

function boundedHeader(repoRoot, path) {
  if (!repoRoot || !path) return "";
  const resolved = createRepoBoundary(repoRoot).resolve(path);
  if (!resolved.ok) return "";
  let fd;
  try {
    fd = openSync(resolved.path, "r");
    const buf = Buffer.alloc(HEADER_BYTES);
    const count = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, count).toString("utf8");
  } catch { return ""; }
  finally { if (fd != null) try { closeSync(fd); } catch { /* already closed */ } }
}

export function loadPathClassificationConfig(repoRoot) {
  if (!repoRoot) return { classify: {}, exclude: [], loaded: false };
  const resolved = createRepoBoundary(repoRoot).resolve(".weavatrix.json");
  if (!resolved.ok) return { classify: {}, exclude: [], loaded: false };
  try {
    if (statSync(resolved.path).size > MAX_CONFIG_BYTES) return { classify: {}, exclude: [], loaded: false, error: "config-too-large" };
    const raw = JSON.parse(readFileSync(resolved.path, "utf8"));
    const classify = {};
    for (const category of PATH_CLASS_NAMES) {
      const value = raw?.classify?.[category];
      const patterns = (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
        .slice(0, MAX_RULES_PER_CLASS)
        .map((pattern) => String(pattern));
      if (patterns.length) classify[category] = patterns;
    }
    // Explicit product opt-in removes only the default benchmark/temp classification. It does not
    // override configured generated/test classes or a deliberate top-level exclude rule.
    const productValue = raw?.classify?.product;
    const productPatterns = (Array.isArray(productValue) ? productValue : typeof productValue === "string" ? [productValue] : [])
      .slice(0, MAX_RULES_PER_CLASS)
      .map((pattern) => String(pattern));
    if (productPatterns.length) classify.product = productPatterns;
    const exclude = (Array.isArray(raw?.exclude) ? raw.exclude : typeof raw?.exclude === "string" ? [raw.exclude] : [])
      .slice(0, MAX_RULES_PER_CLASS)
      .map((pattern) => String(pattern));
    return { classify, exclude, loaded: true };
  } catch { return { classify: {}, exclude: [], loaded: false, error: "invalid-config" }; }
}

function configuredRules(config) {
  const rules = [];
  for (const category of PATH_CLASS_NAMES) {
    for (const pattern of config.classify?.[category] || []) {
      const regex = compileGlob(pattern);
      if (regex) rules.push({ category, pattern, regex, source: "config" });
    }
  }
  const excludes = [];
  for (const pattern of config.exclude || []) {
    const regex = compileGlob(pattern);
    if (regex) excludes.push({ pattern, regex, source: "config" });
  }
  const productRules = [];
  for (const pattern of config.classify?.product || []) {
    const regex = compileGlob(pattern);
    if (regex) productRules.push({ category: "product", pattern, regex, source: "config" });
  }
  return { rules, excludes, productRules };
}

export function createPathClassifier(repoRoot) {
  const config = loadPathClassificationConfig(repoRoot);
  const compiled = configuredRules(config);
  return {
    config,
    explain(path, options = {}) {
      const normalized = normalizePath(path);
      const matches = [];
      const classes = new Set();
      const productMatches = compiled.productRules
        .filter((rule) => rule.regex.test(normalized))
        .map((rule) => ({ category: "product", source: rule.source, pattern: rule.pattern }));
      matches.push(...productMatches);
      const productOverride = productMatches.length > 0;
      const add = (rule) => {
        classes.add(rule.category);
        if (rule.category === "e2e") classes.add("test");
        matches.push({ category: rule.category, source: rule.source || "default", pattern: rule.pattern });
      };
      for (const rule of compiled.rules) if (rule.regex.test(normalized)) add(rule);
      for (const rule of DEFAULT_RULES) {
        if (productOverride && (rule.category === "benchmark" || rule.category === "temp")) continue;
        if (rule.regex.test(normalized)) add({ ...rule, source: "default" });
      }
      const header = options.content == null ? boundedHeader(repoRoot, normalized) : String(options.content).slice(0, HEADER_BYTES);
      if (GENERATED_HEADER_RE.test(header) && !classes.has("generated")) {
        add({ category: "generated", source: "default", pattern: "generated-file header" });
      }
      const excludeMatches = compiled.excludes
        .filter((rule) => rule.regex.test(normalized))
        .map((rule) => ({ category: "exclude", source: rule.source, pattern: rule.pattern }));
      matches.push(...excludeMatches);
      const orderedClasses = PATH_CLASS_NAMES.filter((category) => classes.has(category));
      return {
        path: normalized,
        classes: orderedClasses,
        excluded: excludeMatches.length > 0,
        productOverride,
        matchedRule: matches[0] || null,
        matchedRules: matches,
      };
    },
  };
}

export function explainPathClassification(repoRoot, path, options = {}) {
  return createPathClassifier(repoRoot).explain(path, options);
}

export function hasPathClass(explanation, ...categories) {
  const present = new Set(explanation?.classes || []);
  return categories.some((category) => PATH_CLASS_SET.has(category) && present.has(category));
}
