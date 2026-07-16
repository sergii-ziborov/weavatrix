// TypeScript/JavaScript barrel transparency. The parser keeps physical import/re-export edges for
// execution-order and cycle analysis; this post-pass resolves public export names to their declaring
// files, marks the physical facade hops as proxies, and adds direct semantic importer -> origin edges.
// Resolution follows ESM rules that matter for a static graph: explicit exports shadow `export *`,
// `default` never flows through a star, cycles terminate, and conflicting star origins stay ambiguous.

const resolved = (file, name, typeOnly = false) => ({ status: "resolved", origin: { file, name, typeOnly } });
const MISSING = Object.freeze({ status: "missing" });
const AMBIGUOUS = Object.freeze({ status: "ambiguous" });

function mergeCandidates(candidates) {
  if (candidates.some((candidate) => candidate.status === "ambiguous")) return AMBIGUOUS;
  const origins = new Map();
  for (const candidate of candidates) {
    if (candidate.status !== "resolved") continue;
    const key = `${candidate.origin.file}\0${candidate.origin.name}`;
    const current = origins.get(key);
    if (!current) origins.set(key, { ...candidate.origin });
    else current.typeOnly = current.typeOnly && candidate.origin.typeOnly;
  }
  if (!origins.size) return MISSING;
  if (origins.size > 1) return AMBIGUOUS;
  return { status: "resolved", origin: [...origins.values()][0] };
}

function withTypeOnly(result, typeOnly) {
  if (result.status !== "resolved" || !typeOnly) return result;
  return resolved(result.origin.file, result.origin.name, true);
}

export function resolveJsBarrels({ jsExports, importedLocals, links }) {
  const tables = new Map();
  for (const [file, records] of jsExports) {
    const table = { explicit: new Map(), stars: [] };
    for (const record of records || []) {
      if (record.kind === "star") {
        table.stars.push(record);
        continue;
      }
      if (!record.exported) continue;
      const list = table.explicit.get(record.exported) || [];
      list.push(record);
      table.explicit.set(record.exported, list);
    }
    tables.set(file, table);
  }

  const cache = new Map();
  const resolveExport = (file, name, trail = new Set()) => {
    const key = `${file}\0${name}`;
    const rootResolution = trail.size === 0;
    if (cache.has(key)) return cache.get(key);
    if (trail.has(key)) return MISSING;
    const table = tables.get(file);
    if (!table) return MISSING;
    const nextTrail = new Set(trail);
    nextTrail.add(key);

    const explicit = table.explicit.get(name) || [];
    if (explicit.length) {
      const candidates = explicit.map((record) => {
        if (record.kind === "named") {
          return withTypeOnly(resolveExport(record.targetFile, record.imported, nextTrail), record.typeOnly);
        }
        if (record.kind === "namespace") return resolved(record.targetFile, "*", record.typeOnly);
        const local = record.local || name;
        const binding = importedLocals.get(file)?.get(local);
        if (binding?.targetFile && binding.imported && binding.imported !== "*") {
          return withTypeOnly(resolveExport(binding.targetFile, binding.imported, nextTrail), record.typeOnly || binding.typeOnly);
        }
        // Type/interface declarations are intentionally not symbol nodes yet, but their declaring file is
        // still the correct semantic origin for file/module dependency analysis.
        return resolved(file, local, record.typeOnly);
      });
      const result = mergeCandidates(candidates);
      if (rootResolution) cache.set(key, result);
      return result;
    }

    if (name === "default") {
      if (rootResolution) cache.set(key, MISSING);
      return MISSING;
    }
    const candidates = table.stars.map((star) => withTypeOnly(resolveExport(star.targetFile, name, nextTrail), star.typeOnly));
    const result = mergeCandidates(candidates);
    if (rootResolution) cache.set(key, result);
    return result;
  };

  // Every internal re-export is a physical facade hop. It remains in the graph for runtime cycle truth,
  // but semantic consumers ignore it in favor of importer -> declaration edges below.
  for (const link of links) {
    if (link.relation !== "re_exports") continue;
    const records = jsExports.get(String(link.source)) || [];
    if (records.some((record) => record.targetFile === String(link.target))) link.barrelProxy = true;
  }

  const semanticEdges = new Map();
  const addSemanticEdge = (source, imp, origin, usage = null, force = false) => {
    if (!origin?.file || (!force && origin.file === imp.targetFile)) return;
    const key = `${source}\0${origin.file}\0${imp.line || 0}`;
    const effectiveTypeOnly = imp.typeOnly === true || origin.typeOnly === true;
    const current = semanticEdges.get(key);
    if (current) {
      if (!effectiveTypeOnly) delete current.typeOnly;
      return;
    }
    semanticEdges.set(key, {
      source,
      target: origin.file,
      relation: "imports",
      confidence: "EXTRACTED",
      semanticOrigin: true,
      viaBarrel: imp.targetFile,
      ...(effectiveTypeOnly ? { typeOnly: true } : {}),
      ...(imp.line ? { line: imp.line } : {}),
      ...(imp.specifier ? { specifier: imp.specifier } : {}),
      ...(usage ? { usage } : {}),
    });
  };

  const proxiedImportGroups = new Set();
  for (const [source, imports] of importedLocals) {
    for (const imp of imports.values()) {
      if (!imp?.targetFile || imp.imported === "*") continue;
      const result = resolveExport(imp.targetFile, imp.imported);
      if (result.status !== "resolved") continue;
      imp.originFile = result.origin.file;
      imp.originName = result.origin.name;
      imp.originTypeOnly = result.origin.typeOnly === true;
      if (result.origin.file === imp.targetFile) continue;
      proxiedImportGroups.add(`${source}\0${imp.targetFile}\0${imp.line || 0}`);
      for (const link of links) {
        if (String(link.source) === source && String(link.target) === imp.targetFile && link.relation === "imports"
          && (!imp.line || !link.line || link.line === imp.line)) link.barrelProxy = true;
      }
      addSemanticEdge(source, imp, result.origin);
    }
  }
  // One import statement can mix a barrel-local export with re-exported bindings. Once its physical
  // file edge becomes a proxy, preserve the local binding as its own semantic edge to the barrel file.
  for (const [source, imports] of importedLocals) for (const imp of imports.values()) {
    if (!imp?.originFile || imp.originFile !== imp.targetFile) continue;
    if (!proxiedImportGroups.has(`${source}\0${imp.targetFile}\0${imp.line || 0}`)) continue;
    addSemanticEdge(source, imp, { file: imp.originFile, name: imp.originName, typeOnly: imp.originTypeOnly }, null, true);
  }
  links.push(...semanticEdges.values());

  // Namespace member usage is only knowable in pass 2 (`ui.Button`, `ui.run`). Expose a bounded helper
  // that uses the same cache and emits the corresponding semantic file edge exactly once.
  const resolveNamespaceMember = (source, imp, member, usage = null) => {
    if (!imp?.targetFile || imp.imported !== "*") return MISSING;
    const result = resolveExport(imp.targetFile, member);
    if (result.status !== "resolved") return result;
    if (result.origin.file !== imp.targetFile) {
      for (const link of links) {
        if (String(link.source) === source && String(link.target) === imp.targetFile && link.relation === "imports"
          && (!imp.line || !link.line || link.line === imp.line)) link.barrelProxy = true;
      }
      addSemanticEdge(source, imp, result.origin, usage);
      // addSemanticEdge may have created a new entry after the initial push.
      const edge = semanticEdges.get(`${source}\0${result.origin.file}\0${imp.line || 0}`);
      if (edge && !links.includes(edge)) links.push(edge);
    }
    return result;
  };

  return { resolveExport, resolveNamespaceMember };
}
