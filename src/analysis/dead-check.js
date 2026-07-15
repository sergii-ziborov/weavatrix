// Portable, language-agnostic DEAD-code checker. A symbol is DEAD when it has NO inbound graph edge (nothing
// calls/imports/references/inherits it) AND its bare name appears NOWHERE in the repo outside its own file.
// A file is DEAD when nothing imports it, it isn't an entry point, and all its symbols are dead.
//
// Pure core `computeDead(graph, sources)` (sources = Map<fileRel, text>) is fully testable with no filesystem.
// `analyzeDeadCode(graph, repoRoot)` is the thin fs wrapper. Works on ANY graph-builder-schema graph (built-in OR
// graph-builder) — it only needs {nodes, links} + the source text. See [[graph-builder-internalization]].
import { readFileSync } from "node:fs";
import { createRepoBoundary } from "../repo-path.js";

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const bareName = (label) => String(label || "").replace(/\s*\(.*$/, "").replace(/[()]/g, "").trim();
// entry surfaces are never dead even with no inbound edge (framework/CLI/HTTP enter them externally).
// Exported for internal-audit.js (reachability entry set) — keep the two in lockstep.
export const ENTRY_FILE = /(^|[\\/])(index|main|app|server|cli|cmd|bootstrap|entry|run|__main__|manage|wsgi|asgi|setup|conftest)\.[a-z0-9]+$|(^|[\\/])(bin|cmd)[\\/]|(^|[\\/])main\.go$/i;
const TEST_FILE = /(^|[\\/])[^\\/]*[._-](test|spec)\.[a-z0-9]+$|(^|[\\/])(test|tests|__tests__|spec)[\\/]/i;

export function computeDead(graph, sources) {
  const nodes = graph.nodes || [], links = graph.links || [];
  const ep = (v) => (v && typeof v === "object" ? v.id : v);
  const inbound = new Set();
  for (const l of links) if (l.relation !== "contains") inbound.add(ep(l.target));

  // whole-repo identifier frequency: a symbol whose name appears MORE than once total (its definition + at least
  // one use, same-file OR cross-file) is referenced. Errs toward "alive" (common-named symbols never flagged).
  const globalFreq = new Map();
  for (const [, text] of sources) for (const m of String(text || "").matchAll(IDENT_RE)) { const n = m[0]; globalFreq.set(n, (globalFreq.get(n) || 0) + 1); }

  const symById = new Map();
  const symsByFile = new Map();
  for (const n of nodes) {
    if (!String(n.id).includes("#")) continue;
    symById.set(n.id, n);
    (symsByFile.get(n.source_file) || symsByFile.set(n.source_file, []).get(n.source_file)).push(n);
  }

  // decorated defs (@app.route/@app.event/@pytest.fixture…) are entered by the framework: trust the
  // builder's flag when present, else walk the source line(s) above the definition (graph-builder graphs).
  const lineCache = new Map();
  const linesOf = (f) => { let l = lineCache.get(f); if (!l) { l = String(sources.get(f) || "").split(/\r?\n/); lineCache.set(f, l); } return l; };
  const symLine = (n) => { const m = /@(\d+)$/.exec(String(n.id)) || /L(\d+)/.exec(String(n.source_location || "")); return m ? Number(m[1]) : 0; };
  const isDecorated = (n) => {
    if (n.decorated) return true;
    const ln = symLine(n);
    if (!ln) return false;
    const lines = linesOf(n.source_file);
    for (let i = ln - 2; i >= 0 && i >= ln - 6; i--) {
      const t = (lines[i] || "").trim();
      if (t.startsWith("@")) return true;
      if (t === "" || t.startsWith("#")) continue;
      break;
    }
    return false;
  };

  const isReferenced = (n) => {
    if (inbound.has(n.id)) return true;                          // a real graph edge targets it
    const name = bareName(n.label);
    if (!name || !/^[A-Za-z_$]/.test(name)) return true;         // selectors/odd labels → don't flag
    if (/^__\w+__$/.test(name)) return true;                     // dunders are invoked implicitly (with/str/==/iter…), never spelled
    if ((globalFreq.get(name) || 0) > 1) return true;            // name appears beyond its single definition
    return isDecorated(n);                                       // framework-registered via decorator
  };

  const deadSymbols = [];
  for (const n of symById.values()) {
    if (isReferenced(n)) continue;
    const test = TEST_FILE.test(n.source_file);
    deadSymbols.push({ id: n.id, file: n.source_file, label: n.label, test, reason: "no inbound edge and name unreferenced outside its file" });
  }
  const deadSet = new Set(deadSymbols.map((s) => s.id));

  const deadFiles = [];
  for (const n of nodes) {
    if (String(n.id).includes("#")) continue;                   // file nodes only
    if (inbound.has(n.id) || ENTRY_FILE.test(n.source_file)) continue;
    const syms = symsByFile.get(n.source_file) || [];
    if (syms.length && syms.every((s) => deadSet.has(s.id))) deadFiles.push({ file: n.source_file, reason: "not imported; all symbols unreferenced" });
  }

  return {
    deadSymbols,
    deadFiles,
    referencedIds: [...symById.values()].filter(isReferenced).map((n) => n.id),
    stats: { symbols: symById.size, deadSymbols: deadSymbols.length, files: nodes.filter((n) => !String(n.id).includes("#")).length, deadFiles: deadFiles.length },
  };
}

// Export-scoped unused check (knip's "unused exports"): an EXPORTED symbol (P0's exported:true flag)
// with no inbound non-contains edge whose bare name occurs in NO file other than its own. Same-file-only
// usage means the symbol is alive but the export is not — still worth surfacing. Pure like computeDead.
// dynamicTargets = files reached via dynamic import() — their exports are consumed at runtime, skip them.
export function computeUnusedExports(graph, sources, { dynamicTargets = new Set() } = {}) {
  const nodes = graph.nodes || [], links = graph.links || [];
  const ep = (v) => (v && typeof v === "object" ? v.id : v);
  const inbound = new Set();
  for (const l of links) if (l.relation !== "contains") inbound.add(ep(l.target));

  const candidates = [];
  const wanted = new Set();
  for (const n of nodes) {
    if (!n.exported || !String(n.id).includes("#") || inbound.has(n.id)) continue;
    if (ENTRY_FILE.test(n.source_file) || dynamicTargets.has(n.source_file)) continue;
    const nm = bareName(n.label);
    if (!nm || !/^[A-Za-z_$]/.test(nm)) continue;
    candidates.push({ n, nm });
    wanted.add(nm);
  }
  if (!candidates.length) return [];

  const occursIn = new Map(); // name -> Set(files whose text contains it)
  for (const [file, text] of sources) {
    for (const m of String(text || "").matchAll(IDENT_RE)) {
      const w = m[0];
      if (!wanted.has(w)) continue;
      (occursIn.get(w) || occursIn.set(w, new Set()).get(w)).add(file);
    }
  }

  const out = [];
  for (const { n, nm } of candidates) {
    const occ = occursIn.get(nm);
    if (occ && [...occ].some((f) => f !== n.source_file)) continue; // referenced beyond its own file → alive
    out.push({ id: n.id, file: n.source_file, label: n.label, test: TEST_FILE.test(n.source_file), reason: "exported but never imported or referenced outside its own file" });
  }
  return out;
}

// fs wrapper: reads each graph file's source once, then runs the pure checker.
export function analyzeDeadCode(graph, repoRoot) {
  const sources = new Map();
  const files = new Set();
  const boundary = createRepoBoundary(repoRoot);
  for (const n of graph.nodes || []) if (n.source_file) files.add(n.source_file);
  for (const f of files) {
    const resolved = boundary.resolve(f);
    if (!resolved.ok) continue;
    try { sources.set(f, readFileSync(resolved.path, "utf8")); } catch { /* file gone */ }
  }
  return computeDead(graph, sources);
}
