// internal-audit.reach.js — entry-point discovery + file-level reachability BFS for the internal
// audit. Split from internal-audit.js.
import { posix } from "node:path";
import { ENTRY_FILE, isFrameworkEntryFile } from "./dead-check.js";
import { TEST_FILE_RE } from "./internal-audit.collect.js";
import { maskJavaNonCode } from "./java-source.js";

const isFileNode = (n) => !String(n.id).includes("#");

const springAnnotation = (name) => new RegExp(`@(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*${name}\\b`);
const SPRING_CONVENTIONS = [
  ["SpringBootApplication", "high", "Spring Boot application entry point is launched externally and starts component scanning"],
  ["RestControllerAdvice", "high", "Spring registers @RestControllerAdvice through application-context scanning"],
  ["ControllerAdvice", "high", "Spring registers @ControllerAdvice through application-context scanning"],
  ["RestController", "high", "Spring registers @RestController through component scanning and routes requests to it"],
  ["Controller", "high", "Spring registers @Controller through component scanning"],
  ["Configuration", "high", "Spring discovers @Configuration and invokes its bean definitions externally"],
  ["Service", "high", "Spring registers @Service through component scanning"],
  ["Repository", "high", "Spring registers @Repository through component scanning or repository proxy creation"],
  ["Component", "high", "Spring registers @Component through component scanning"],
  ["ConfigurationProperties", "high", "Spring binds @ConfigurationProperties outside the static import graph"],
  ["KafkaListener", "high", "Spring Kafka invokes @KafkaListener methods from the message container"],
  ["Scheduled", "high", "Spring invokes @Scheduled methods from its task scheduler"],
  ["EventListener", "high", "Spring invokes @EventListener methods from the application event bus"],
];

// Framework-managed Java files are externally entered by the Spring container, not by an ordinary
// source import. Return bounded, explainable evidence so suppressing an orphan is never a silent guess.
export function springConventionEntries(sources, fileSet = null) {
  const out = [];
  for (const [rawFile, rawText] of sources || []) {
    const file = String(rawFile || "").replace(/\\/g, "/");
    if (!/\.java$/i.test(file) || (fileSet && !fileSet.has(file))) continue;
    const text = maskJavaNonCode(rawText);
    let evidence = null;
    for (const [marker, confidence, reason] of SPRING_CONVENTIONS) {
      if (springAnnotation(marker).test(text)) {
        evidence = { file, framework: "spring", marker: `@${marker}`, confidence, reason };
        break;
      }
    }
    if (!evidence && /\binterface\s+[A-Za-z_$][\w$]*(?:\s*<[^>{}]+>)?\s+extends\s+[^;{]*(?:JpaRepository|MongoRepository|ReactiveCrudRepository|CrudRepository|PagingAndSortingRepository|Repository)\s*</s.test(text)) {
      evidence = {
        file,
        framework: "spring-data",
        marker: "repository interface",
        confidence: "high",
        reason: "Spring Data creates the repository implementation and proxy from the interface at runtime",
      };
    }
    if (evidence) out.push(evidence);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// Entry set for reachability: conventional entry names + package.json main/module/browser/bin/exports +
// html pages (they root classic-script apps) + test files (the runner enters them) + root config files +
// dynamic-import targets. Anything reachable from here is "used"; the rest corroborates unused-file.
export function entryFiles(graph, pkgOrScopes, dynamicTargets = new Set(), { declaredEntries = [], sources = new Map(), conventionEvidence = [] } = {}) {
  const entries = new Set();
  const scopes = Array.isArray(pkgOrScopes)
    ? pkgOrScopes
    : [{ root: "", manifest: "package.json", pkg: pkgOrScopes || {} }];
  const fileSet = new Set((graph.nodes || []).filter(isFileNode).map((n) => String(n.source_file || n.id).replace(/\\/g, "/")));
  const pe = new Set();
  const resolveEntry = (root, raw) => {
    let p = String(raw || "").trim().replace(/^['"]|['"]$/g, "").replace(/^file:/, "").replace(/\\/g, "/");
    if (!p || p.startsWith("-") || /^https?:/.test(p)) return "";
    p = p.replace(/^\.\//, "");
    const joined = posix.normalize(root ? posix.join(root, p) : p).replace(/^\.\//, "");
    if (fileSet.has(joined)) return joined;
    for (const ext of [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py"]) if (fileSet.has(joined + ext)) return joined + ext;
    return joined;
  };
  for (const scope of scopes) {
    const pkg = scope.pkg || {};
    const root = String(scope.root || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const pkgEntries = [];
    for (const k of ["main", "module", "browser"]) if (typeof pkg[k] === "string") pkgEntries.push(pkg[k]);
    if (pkg.bin) pkgEntries.push(...(typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin)));
    (function walkExports(e) {
      if (typeof e === "string") pkgEntries.push(e);
      else if (e && typeof e === "object") Object.values(e).forEach(walkExports);
    })(pkg.exports);
    // Script commands are external entry surfaces. Extract only path-shaped source tokens; package names,
    // flags and shell operators are intentionally ignored.
    for (const script of Object.values(pkg.scripts || {})) {
      const re = /(?:^|[\s'"=])((?:\.?\.?\/)?[\w@./-]+\.(?:[cm]?[jt]sx?|py|go))(?=$|[\s'";,)&|])/gi;
      let m;
      while ((m = re.exec(String(script)))) pkgEntries.push(m[1]);
      const runner = /\b(?:node|bun|deno|tsx|ts-node|python\d*|electron)\s+(?!-)([\w@./\\-]+)/gi;
      while ((m = runner.exec(String(script)))) if (/[./\\]/.test(m[1])) pkgEntries.push(m[1]);
    }
    for (const p of pkgEntries) pe.add(resolveEntry(root, p));
  }
  for (const n of graph.nodes || []) {
    if (!isFileNode(n)) continue;
    const f = n.source_file;
    if (ENTRY_FILE.test(f) || isFrameworkEntryFile(f) || /\.d\.[cm]?ts$/i.test(f) || TEST_FILE_RE.test(f) || /\.html?$/i.test(f) || pe.has(f) || /(^|\/)[^/]*\.config\.[a-z]+$/i.test(f)) entries.add(f);
  }
  for (const evidence of springConventionEntries(sources, fileSet)) {
    entries.add(evidence.file);
    conventionEvidence.push(evidence);
  }
  for (const raw of Array.isArray(declaredEntries) ? declaredEntries : [declaredEntries]) {
    const resolved = resolveEntry("", raw);
    if (resolved && fileSet.has(resolved)) entries.add(resolved);
  }
  // Bundled helper programs are often launched by filename (`resolveResource("worker.py")`) rather than
  // imported. A quoted basename reference from another source file is enough to establish that a code file
  // under resources/ is a runtime entry, without treating arbitrary prose/config files as roots.
  for (const file of fileSet) {
    if (!/(^|\/)resources\/.*\.(?:py|[cm]?[jt]s)$/i.test(file)) continue;
    const base = posix.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = new RegExp(`["'\x60]${base}["'\x60]`);
    if ([...sources].some(([other, text]) => other !== file && quoted.test(String(text || "")))) entries.add(file);
  }
  for (const t of dynamicTargets) entries.add(t);
  return entries;
}

// File-level BFS over every non-contains link (symbol endpoints collapse to their file via the id prefix).
export function computeReachability(graph, entries) {
  const fileOf = (v) => { const s = String(v && typeof v === "object" ? v.id : v); const h = s.indexOf("#"); return h < 0 ? s : s.slice(0, h); };
  const adj = new Map();
  for (const l of graph.links || []) {
    if (l.relation === "contains") continue;
    const a = fileOf(l.source), b = fileOf(l.target);
    if (!a || !b || a === b) continue;
    (adj.get(a) || adj.set(a, new Set()).get(a)).add(b);
  }
  const reached = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const cur = queue.pop();
    for (const nxt of adj.get(cur) || []) if (!reached.has(nxt)) { reached.add(nxt); queue.push(nxt); }
  }
  return reached;
}
