// internal-audit.reach.js — entry-point discovery + file-level reachability BFS for the internal
// audit. Split from internal-audit.js.
import { ENTRY_FILE } from "./dead-check.js";
import { TEST_FILE_RE } from "./internal-audit.collect.js";

const isFileNode = (n) => !String(n.id).includes("#");

// Entry set for reachability: conventional entry names + package.json main/module/browser/bin/exports +
// html pages (they root classic-script apps) + test files (the runner enters them) + root config files +
// dynamic-import targets. Anything reachable from here is "used"; the rest corroborates unused-file.
export function entryFiles(graph, pkg, dynamicTargets) {
  const entries = new Set();
  const pkgEntries = [];
  for (const k of ["main", "module", "browser"]) if (typeof pkg[k] === "string") pkgEntries.push(pkg[k]);
  if (pkg.bin) pkgEntries.push(...(typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin)));
  (function walkExports(e) {
    if (typeof e === "string") pkgEntries.push(e);
    else if (e && typeof e === "object") Object.values(e).forEach(walkExports);
  })(pkg.exports);
  const pe = new Set(pkgEntries.map((p) => String(p).replace(/^\.\//, "").replace(/\\/g, "/")));
  for (const n of graph.nodes || []) {
    if (!isFileNode(n)) continue;
    const f = n.source_file;
    if (ENTRY_FILE.test(f) || TEST_FILE_RE.test(f) || /\.html?$/i.test(f) || pe.has(f) || /(^|\/)[^/]*\.config\.[a-z]+$/i.test(f)) entries.add(f);
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
