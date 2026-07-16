// Pure structure checker (replaces dependency-cruiser's core): circular dependencies (iterative Tarjan
// SCC + one representative cycle each), orphan files, and a small glob boundary-rule DSL evaluated over
// the graph's file-level import edges. NO filesystem — internal-audit.js feeds it. DEPS_SECURITY_PLAN P2.
//
// Honest gaps vs depcruise: we don't follow imports INTO node_modules and don't run enhanced-resolve
// (package.json#exports / webpack resolution), so some cycles it sees we can't. Cycles we DO report are
// built from EXTRACTED import edges → high confidence.
import { makeFinding } from "./findings.js";
import { ENTRY_FILE } from "./dead-check.js";
import { formatRepresentativeCycle } from "./cycle-route.js";
const TEST_FILE_RE = /(^|[/])(test|tests|__tests__|spec|e2e|__mocks__)([/]|$)|[._-](test|spec)\.[a-z0-9]+$/i;
// config/data/docs: never "orphans" — nothing imports them by design
const NON_CODE_RE = /\.(json|ya?ml|sh|ps1|md|txt|html?|css|scss|less)$|(^|[/])(dockerfile|containerfile)/i;
const ep = (v) => String(v && typeof v === "object" ? v.id : v);
const fileOf = (v) => { const s = ep(v); const h = s.indexOf("#"); return h < 0 ? s : s.slice(0, h); };
const dirOf = (f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
// File-level import adjacency. Go same-directory edges are excluded: a Go package IS the directory, the
// compiler forbids real cross-package cycles, and our suffix-fallback Go resolution could fake them.
export function buildFileImportGraph(graph, { includeTypeOnly = false, includeCompileOnly = false } = {}) {
  const fileIds = new Set();
  for (const n of graph.nodes || []) if (!String(n.id).includes("#")) fileIds.add(String(n.id));
  const runtimeAdj = new Map();       // runtime/value imports only
  const allAdj = new Map();           // runtime + compile-time-only, used to describe architectural coupling
  const edges = [];
  const allEdges = [];
  const typeOnlyEdges = [];
  const compileOnlyEdges = [];
  const compileTimeEdges = [];
  const runtimeSeen = new Set(), allSeen = new Set(), typeSeen = new Set(), compileSeen = new Set(), compileTimeSeen = new Set();
  const add = (map, a, b) => {
    let set = map.get(a);
    if (!set) map.set(a, (set = new Set()));
    set.add(b);
  };
  for (const l of graph.links || []) {
    if (l.relation !== "imports" && l.relation !== "re_exports") continue;
    const a = ep(l.source), b = ep(l.target);
    if (!fileIds.has(a) || !fileIds.has(b) || a === b) continue;
    if (a.endsWith(".go") && b.endsWith(".go") && dirOf(a) === dirOf(b)) continue;
    const key = `${a}\0${b}`;
    if (!allSeen.has(key)) { allSeen.add(key); add(allAdj, a, b); allEdges.push([a, b]); }
    if (l.typeOnly === true || l.compileOnly === true) {
      if (l.typeOnly === true && !typeSeen.has(key)) { typeSeen.add(key); typeOnlyEdges.push([a, b]); }
      if (l.compileOnly === true && !compileSeen.has(key)) { compileSeen.add(key); compileOnlyEdges.push([a, b]); }
      if (!compileTimeSeen.has(key)) { compileTimeSeen.add(key); compileTimeEdges.push([a, b]); }
      continue;
    }
    if (!runtimeSeen.has(key)) { runtimeSeen.add(key); add(runtimeAdj, a, b); edges.push([a, b]); }
  }
  const pureTypeOnlyEdges = typeOnlyEdges.filter(([a, b]) => !runtimeSeen.has(`${a}\0${b}`));
  const pureCompileOnlyEdges = compileOnlyEdges.filter(([a, b]) => !runtimeSeen.has(`${a}\0${b}`));
  const pureCompileTimeEdges = compileTimeEdges.filter(([a, b]) => !runtimeSeen.has(`${a}\0${b}`));
  return {
    fileIds,
    adj: includeTypeOnly || includeCompileOnly ? allAdj : runtimeAdj,
    edges: includeTypeOnly || includeCompileOnly ? allEdges : edges,
    runtimeAdj,
    runtimeEdges: edges,
    allAdj,
    allEdges,
    typeOnlyEdges: pureTypeOnlyEdges,
    compileOnlyEdges: pureCompileOnlyEdges,
    compileTimeEdges: pureCompileTimeEdges,
  };
}
// Iterative Tarjan (deep graphs must not blow the JS stack). Returns only non-trivial SCCs (size > 1).
export function findSccs(adj) {
  const index = new Map(), low = new Map(), onStack = new Set(), S = [];
  let counter = 0;
  const sccs = [];
  for (const root of adj.keys()) {
    if (index.has(root)) continue;
    index.set(root, counter); low.set(root, counter); counter++;
    S.push(root); onStack.add(root);
    const stack = [{ v: root, ci: 0, neigh: [...(adj.get(root) || [])] }];
    while (stack.length) {
      const fr = stack[stack.length - 1];
      if (fr.ci < fr.neigh.length) {
        const w = fr.neigh[fr.ci++];
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          S.push(w); onStack.add(w);
          stack.push({ v: w, ci: 0, neigh: [...(adj.get(w) || [])] });
        } else if (onStack.has(w)) {
          low.set(fr.v, Math.min(low.get(fr.v), index.get(w)));
        }
      } else {
        stack.pop();
        if (stack.length) { const p = stack[stack.length - 1]; low.set(p.v, Math.min(low.get(p.v), low.get(fr.v))); }
        if (low.get(fr.v) === index.get(fr.v)) {
          const comp = [];
          let w;
          do { w = S.pop(); onStack.delete(w); comp.push(w); } while (w !== fr.v);
          if (comp.length > 1) sccs.push(comp);
        }
      }
    }
  }
  return sccs;
}
// One representative (shortest) cycle through an SCC's lexicographically-first file — a readable path,
// not the full Johnson enumeration (which explodes combinatorially on big tangles).
export function representativeCycle(adj, scc) {
  const inScc = new Set(scc);
  const start = [...scc].sort()[0];
  const prev = new Map([[start, null]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const nxt of [...(adj.get(cur) || [])].sort()) {
      if (nxt === start) {
        const path = [];
        for (let c = cur; c != null; c = prev.get(c)) path.push(c);
        return [...path.reverse(), start];
      }
      if (!inScc.has(nxt) || prev.has(nxt)) continue;
      prev.set(nxt, cur);
      q.push(nxt);
    }
  }
  const fallback = [...scc].sort();
  return [...fallback, fallback[0]]; // unreachable in a true SCC; deterministic safe fallback
}
// Orphans: file nodes with ZERO non-contains graph degree (nothing in, nothing out — imports, calls,
// references all collapsed to files). Entries/tests/config-data are exempt. A file that DOES import
// npm packages (externalImports) is a working script, not an island — confidence drops, not the verdict.
export function findOrphans(graph, { entrySet = new Set(), externalImportFiles = new Set() } = {}) {
  const deg = new Map();
  for (const l of graph.links || []) {
    if (l.relation === "contains") continue;
    const a = fileOf(l.source), b = fileOf(l.target);
    if (a === b) continue;
    deg.set(a, (deg.get(a) || 0) + 1);
    deg.set(b, (deg.get(b) || 0) + 1);
  }
  const out = [];
  for (const n of graph.nodes || []) {
    const id = String(n.id);
    if (id.includes("#")) continue;
    if ((deg.get(id) || 0) > 0) continue;
    const f = n.source_file;
    if (entrySet.has(f) || ENTRY_FILE.test(f) || TEST_FILE_RE.test(f) || NON_CODE_RE.test(f)) continue;
    out.push({ file: f, importsExternals: externalImportFiles.has(f) });
  }
  return out;
}
// Boundary DSL — the useful subset of depcruise's forbidden rules, as plain JSON globs:
//   { "forbidden":  [{ "name", "comment"?, "severity"?, "from": "main/**", "to": "renderer/**" }],
//     "allowedOnly":[{ "name", "comment"?, "severity"?, "from": "src/ui/**", "to": ["src/ui/**", "src/shared/**"] }] }
// forbidden fires when an edge matches from AND to; allowedOnly fires when from matches and to matches NONE.
export function globToRe(glob) {
  // split on ** first so single-* expansion cannot touch the multi-segment wildcards
  const parts = String(glob).split("**").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"));
  let s = parts.join(".*");
  s = s.replace(/\/\.\*\//g, "/(?:.*/)?"); // a/**/b also matches a/b (zero middle dirs)
  s = s.replace(/^\.\*\//, "(?:.*/)?");    // **/b also matches root-level b
  return new RegExp(`^${s}$`);
}

export function checkBoundaries(edges, rules = {}) {
  const violations = [];
  const forbidden = (rules.forbidden || []).map((r) => ({ ...r, fromRe: globToRe(r.from), toRe: globToRe(r.to) }));
  const allowedOnly = (rules.allowedOnly || []).map((r) => ({ ...r, fromRe: globToRe(r.from), toRes: (Array.isArray(r.to) ? r.to : [r.to]).map(globToRe) }));
  for (const [a, b] of edges) {
    for (const r of forbidden) if (r.fromRe.test(a) && r.toRe.test(b)) violations.push({ name: r.name, comment: r.comment || "", severity: r.severity, from: a, to: b, kind: "forbidden" });
    for (const r of allowedOnly) if (r.fromRe.test(a) && !r.toRes.some((re) => re.test(b))) violations.push({ name: r.name, comment: r.comment || "", severity: r.severity, from: a, to: b, kind: "allowedOnly" });
  }
  return violations;
}

const MAX_CYCLE_FINDINGS = 50;
const MAX_BOUNDARY_FINDINGS = 100;
// Assemble everything into unified Findings. rules comes from the repo's .weavatrix-deps.json (optional).
export function computeStructureFindings(graph, { rules = {}, entrySet = new Set(), externalImportFiles = new Set() } = {}) {
  const { adj, edges, allAdj, allEdges, typeOnlyEdges, compileOnlyEdges, compileTimeEdges } = buildFileImportGraph(graph);
  const findings = [];
  const sccs = findSccs(adj).sort((a, b) => b.length - a.length);
  for (const scc of sccs.slice(0, MAX_CYCLE_FINDINGS)) {
    const cycle = representativeCycle(adj, scc);
    const cycleRoute = formatRepresentativeCycle(cycle);
    findings.push(makeFinding({
      category: "structure",
      rule: "circular-dep",
      severity: scc.length > 4 ? "high" : "medium",
      confidence: "high",
      title: `Circular dependency: ${scc.length} files`,
      detail: `${cycleRoute}${scc.length + 1 > cycle.length ? ` (representative loop; the tangle spans ${scc.length} files)` : ""}. Break the cycle by extracting the shared piece or inverting one import.`,
      cycleRoute,
      cycleMembers: [...scc].sort(),
      file: cycle[0],
      graphNodeId: cycle[0],
      evidence: cycle.map((f) => ({ file: f, line: 0, snippet: "" })),
      source: "internal",
      fixHint: "extract the shared code into a module both sides import, or invert the weaker dependency",
    }));
  }

  // TypeScript `import type` and Rust module/use edges are compile-time coupling. They can reveal real
  // architecture, but cannot create an initialization-order/runtime cycle. Report SCCs that require
  // either classification separately so agents do not churn working code for a phantom runtime hazard.
  const runtimeKeys = new Set(sccs.map((s) => [...s].sort().join("\0")));
  const allSccs = findSccs(allAdj).sort((a, b) => b.length - a.length);
  const compileTimeCouplings = allSccs.filter((s) => !runtimeKeys.has([...s].sort().join("\0")));
  const edgeCountIn = (scc, list) => {
    const inside = new Set(scc);
    return list.reduce((n, [a, b]) => n + (inside.has(a) && inside.has(b) ? 1 : 0), 0);
  };
  for (const scc of compileTimeCouplings.slice(0, MAX_CYCLE_FINDINGS)) {
    const cycle = representativeCycle(allAdj, scc);
    const cycleRoute = formatRepresentativeCycle(cycle);
    const runtimeInside = edgeCountIn(scc, edges);
    const typeInside = edgeCountIn(scc, typeOnlyEdges);
    const compileInside = edgeCountIn(scc, compileOnlyEdges);
    const containsRuntimeCycle = sccs.some((runtime) => runtime.every((f) => scc.includes(f)));
    const typeSpecific = compileInside === 0;
    findings.push(makeFinding({
      category: "structure",
      rule: typeSpecific ? "type-coupling" : "compile-time-coupling",
      severity: "info",
      confidence: "high",
      title: `${containsRuntimeCycle
        ? (typeSpecific ? "Type imports expand dependency coupling" : "Compile-time edges expand dependency coupling")
        : (typeSpecific ? "Type-induced dependency cycle (no runtime cycle)" : "Compile-time dependency cycle (no runtime cycle)")}: ${scc.length} files`,
      detail: `${cycleRoute}. This strongly-connected group needs compile-time-only edges to close; it contains ${runtimeInside} runtime edge(s), ${typeInside} type-only edge(s), and ${compileInside} compile-only edge(s)${containsRuntimeCycle ? ", with a smaller runtime cycle reported separately" : ", while its runtime import graph is acyclic"}. Treat this as design coupling, not an initialization-order failure.`,
      cycleRoute,
      cycleMembers: [...scc].sort(),
      file: cycle[0],
      graphNodeId: cycle[0],
      evidence: cycle.map((f) => ({ file: f, line: 0, snippet: "" })),
      source: "internal",
      fixHint: "review the compile-time ownership only if the coupling impedes changes; no runtime-cycle fix is required",
    }));
  }
  if (sccs.length > MAX_CYCLE_FINDINGS) {
    findings.push(makeFinding({
      category: "structure", rule: "circular-dep", severity: "info", confidence: "high",
      title: `…and ${sccs.length - MAX_CYCLE_FINDINGS} more dependency cycles`,
      detail: `Cycle findings are capped at ${MAX_CYCLE_FINDINGS}; ${sccs.length} strongly-connected groups exist in total.`,
      source: "internal",
    }));
  }

  for (const o of findOrphans(graph, { entrySet, externalImportFiles })) {
    findings.push(makeFinding({
      category: "structure",
      rule: "orphan-file",
      severity: "info",
      confidence: o.importsExternals ? "low" : "medium",
      title: `Orphan file: ${o.file}`,
      detail: `No repo file imports it and it imports/calls nothing in the repo${o.importsExternals ? " (it does use npm packages — possibly a standalone script or tool)" : ""}. Possibly dead, possibly an undeclared entry point.`,
      file: o.file,
      graphNodeId: o.file,
      source: "internal",
    }));
  }

  // Architecture boundaries describe executable dependencies by default. Type-only contract sharing is
  // visible in typeCouplings above, but must not be presented as a runtime layer violation.
  const violations = checkBoundaries(edges, rules);
  for (const v of violations.slice(0, MAX_BOUNDARY_FINDINGS)) {
    findings.push(makeFinding({
      category: "structure",
      rule: "boundary-violation",
      severity: ["critical", "high", "medium", "low", "info"].includes(v.severity) ? v.severity : "medium",
      confidence: "high",
      title: `Boundary violation (${v.name}): ${v.from} → ${v.to}`,
      detail: `${v.kind === "allowedOnly" ? "Import leaves the allowed set" : "Forbidden import"}${v.comment ? `: ${v.comment}` : ""}.`,
      file: v.from,
      graphNodeId: v.from,
      evidence: [{ file: v.from, line: 0, snippet: `imports ${v.to}` }],
      source: "internal",
    }));
  }
  if (violations.length > MAX_BOUNDARY_FINDINGS) {
    findings.push(makeFinding({
      category: "structure", rule: "boundary-violation", severity: "info", confidence: "high",
      title: `…and ${violations.length - MAX_BOUNDARY_FINDINGS} more boundary violations`,
      detail: `Boundary findings are capped at ${MAX_BOUNDARY_FINDINGS}; ${violations.length} edges violate the rules in total.`,
      source: "internal",
    }));
  }

  return {
    findings,
    stats: {
      importEdges: allEdges.length,
      runtimeImportEdges: edges.length,
      typeOnlyImportEdges: typeOnlyEdges.length,
      compileOnlyImportEdges: compileOnlyEdges.length,
      compileTimeImportEdges: compileTimeEdges.length,
      cycles: sccs.length,
      runtimeCycles: sccs.length,
      largestCycle: sccs[0]?.length || 0,
      // Backward-compatible aliases remain for edgeTypesV 1 consumers.
      typeCouplings: compileTimeCouplings.length,
      largestTypeCoupling: compileTimeCouplings[0]?.length || 0,
      compileTimeCouplings: compileTimeCouplings.length,
      largestCompileTimeCoupling: compileTimeCouplings[0]?.length || 0,
      orphans: findings.filter((f) => f.rule === "orphan-file").length,
      boundaryViolations: violations.length,
    },
  };
}
