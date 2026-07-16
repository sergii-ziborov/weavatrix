// Conservative incremental graph refresh. This module never writes graph.json: it either returns the
// untouched complete graph, a fully rebuilt graph, or a complete merge of a bounded scoped parse into
// the previous graph. Callers own serialization/locking.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, relative } from "node:path";
import { walk } from "./internal-builder.langs.js";
import { createRepoBoundary } from "../repo-path.js";
import { assignDeterministicCommunities } from "./community.js";

const JS_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const CONFIG_RISK = /(^|\/)(package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|tsconfig(?:\.[^/]*)?\.json|jsconfig(?:\.[^/]*)?\.json|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|pom\.xml|build\.gradle(?:\.kts)?|vite\.config\.[^/]+|webpack\.config\.[^/]+|babel\.config\.[^/]+)$/i;
const CONTROL_FILES = [".gitignore", ".weavatrixignore", ".weavatrix.json"];
const MAX_CONTROL_BYTES = 1_000_000;

const norm = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const endpoint = (value) => String(value && typeof value === "object" ? value.id : value);
const fileOfEndpoint = (value, nodesById) => {
  const id = endpoint(value);
  const source = nodesById.get(id)?.source_file;
  if (source) return norm(source);
  const marker = id.indexOf("#");
  return norm(marker < 0 ? id : id.slice(0, marker));
};

// We only need to know whether a module's public surface changed, not understand its implementation.
// The full tree-sitter pass remains authoritative; this signature is deliberately conservative and
// whitespace-insensitive. Any changed export statement forces a full rebuild.
export function jsExportSignature(text, file = "") {
  if (!JS_EXT.has(extname(file))) return "";
  const source = String(text || "");
  const exports = [];
  const pattern = /\bexport\s+(?:declare\s+)?(?:type\s+)?(?:\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*["'][^"']+["']|\{[\s\S]*?\}(?:\s+from\s*["'][^"']+["'])?|default\s+(?:(?:async\s+)?function\s*\*?|class)?\s*[A-Za-z_$]?[\w$]*|(?:async\s+)?function\s*\*?\s+[A-Za-z_$][\w$]*|class\s+[A-Za-z_$][\w$]*|(?:const|let|var|interface|type|enum)\s+[A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(pattern)) exports.push(match[0].replace(/\s+/g, " ").trim());
  // The general matcher intentionally stops before implementation bodies. Preserve every binding name
  // in multi-declarator exports (`export const a = 1, b = 2`) so adding/removing one cannot slip through.
  for (const match of source.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([^;\n]+)/g)) {
    const names = [];
    for (const part of match[1].split(",")) {
      const declared = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
      if (declared) names.push(declared[1]);
    }
    exports.push(`bindings:${names.join(",")}`);
  }
  return hash(exports.join("\n"));
}

export function snapshotRepository(repoDir, files = walk(repoDir)) {
  const root = String(repoDir);
  const fileHashes = {};
  const fileExportSignatures = {};
  const relativeFiles = [];
  for (const abs of files) {
    const rel = norm(relative(root, abs));
    let body;
    try { body = readFileSync(abs); } catch { continue; }
    relativeFiles.push(rel);
    fileHashes[rel] = hash(body);
    if (JS_EXT.has(extname(rel))) fileExportSignatures[rel] = jsExportSignature(body.toString("utf8"), rel);
  }
  relativeFiles.sort();
  const controlHashes = {};
  const boundary = createRepoBoundary(root);
  for (const rel of CONTROL_FILES) {
    const resolved = boundary.resolve(rel);
    if (!resolved.ok) {
      controlHashes[rel] = resolved.reason === "not-found" ? null : `UNREADABLE:${resolved.reason}`;
      continue;
    }
    try {
      const stats = statSync(resolved.path);
      controlHashes[rel] = stats.isFile() && stats.size <= MAX_CONTROL_BYTES
        ? hash(readFileSync(resolved.path))
        : stats.isFile() ? "UNREADABLE:oversized" : "UNREADABLE:not-file";
    } catch {
      controlHashes[rel] = "UNREADABLE:unreadable";
    }
  }
  const revision = hash([
    ...relativeFiles.map((file) => `${file}:${fileHashes[file]}`),
    ...Object.keys(controlHashes).sort().map((file) => `${file}:${controlHashes[file] ?? "missing"}`),
  ].join("\n"));
  return { files, relativeFiles, fileHashes, fileExportSignatures, controlHashes, revision };
}

function sameRecord(left, right) {
  const a = left && typeof left === "object" ? left : {};
  const b = right && typeof right === "object" ? right : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function changedPaths(previous, current) {
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
  return [...keys].filter((file) => previous?.[file] !== current?.[file]).sort();
}

function isBarrelFile(graph, file) {
  const nodesById = new Map((graph.nodes || []).map((node) => [String(node.id), node]));
  return (graph.links || []).some((link) => {
    const sourceFile = fileOfEndpoint(link.source, nodesById);
    return sourceFile === file && (link.relation === "re_exports" || link.barrelProxy === true);
  });
}

function reverseImporters(graph, changed) {
  const changedSet = new Set(changed);
  const nodesById = new Map((graph.nodes || []).map((node) => [String(node.id), node]));
  const result = new Set();
  for (const link of graph.links || []) {
    const targetFile = fileOfEndpoint(link.target, nodesById);
    if (!changedSet.has(targetFile)) continue;
    const sourceFile = fileOfEndpoint(link.source, nodesById);
    if (sourceFile && sourceFile !== targetFile) result.add(sourceFile);
  }
  return result;
}

function mergeScopedGraph(base, scoped, affected, snapshot) {
  const affectedSet = new Set(affected);
  const baseNodes = Array.isArray(base.nodes) ? base.nodes : [];
  const scopedNodes = Array.isArray(scoped.nodes) ? scoped.nodes : [];
  const baseNodesById = new Map(baseNodes.map((node) => [String(node.id), node]));
  const nodeFile = (node) => norm(node?.source_file || fileOfEndpoint(node?.id, baseNodesById));
  const nodes = [...baseNodes.filter((node) => !affectedSet.has(nodeFile(node))), ...scopedNodes];
  assignDeterministicCommunities(nodes);
  const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
  if (nodesById.size !== nodes.length) throw new Error("incremental merge produced duplicate node ids");

  const baseLinkKept = (link) => {
    const sourceFile = fileOfEndpoint(link.source, baseNodesById);
    // A scoped rebuild owns every outgoing edge of an affected source. Incoming edges from an
    // unaffected source still describe that source and must survive (A -> B -> changed C reparses
    // B+C, but A -> B is not regenerated by the scoped builder). The node-id filter below safely
    // removes an incoming edge when its affected target symbol no longer exists.
    return !affectedSet.has(sourceFile);
  };
  // Base and scoped links are disjoint by source file: every scoped source was removed above. Keep
  // repeated call/reference occurrences intact because occurrence hotspots intentionally use them.
  const links = [...(base.links || []).filter(baseLinkKept), ...(scoped.links || [])]
    .filter((link) => nodesById.has(endpoint(link.source)) && nodesById.has(endpoint(link.target)));

  const externalImports = [
    ...(base.externalImports || []).filter((record) => !affectedSet.has(norm(record?.file))),
    ...(scoped.externalImports || []),
  ];
  const fileNodes = new Set(nodes.filter((node) => !String(node.id).includes("#")).map((node) => norm(node.source_file || node.id)));
  if (fileNodes.size !== snapshot.relativeFiles.length || snapshot.relativeFiles.some((file) => !fileNodes.has(file))) {
    throw new Error("incremental merge did not preserve the complete file universe");
  }

  const merged = {
    ...base,
    nodes,
    links,
    externalImports,
    jsExportRecords: scoped.jsExportRecords || base.jsExportRecords || {},
    fileHashes: snapshot.fileHashes,
    fileExportSignatures: snapshot.fileExportSignatures,
    controlHashes: snapshot.controlHashes,
    graphRevision: snapshot.revision,
  };
  for (const key of ["extImportsV", "edgeTypesV", "complexityV", "repoBoundaryV", "barrelResolutionV", "extractorSchemaV"]) {
    merged[key] = Math.max(Number(base[key]) || 0, Number(scoped[key]) || 0);
  }
  return merged;
}

export async function refreshGraphIncrementally(repoDir, existingGraph, {
  buildGraph,
  maxChangedFiles = 24,
  maxParsedFiles = 80,
  builderOptions = {},
} = {}) {
  const builder = buildGraph || (await import("./internal-builder.js")).buildInternalGraph;
  const snapshot = snapshotRepository(repoDir);
  const full = async (reason, changedFiles = []) => {
    const graph = await builder(repoDir, builderOptions);
    return { graph, kind: "full", changedFiles, reason, revision: graph.graphRevision || snapshot.revision, parsedFiles: snapshot.relativeFiles };
  };

  if (!existingGraph || !existingGraph.fileHashes || !existingGraph.fileExportSignatures
    || !existingGraph.controlHashes || !existingGraph.jsExportRecords || Number(existingGraph.barrelResolutionV) < 1
    || Number(existingGraph.extractorSchemaV) < 1) {
    return full("incremental-baseline-unavailable");
  }
  if (!sameRecord(existingGraph.controlHashes, snapshot.controlHashes)) return full("ignore-or-control-config-changed");

  const oldFiles = Object.keys(existingGraph.fileHashes).sort();
  if (oldFiles.length !== snapshot.relativeFiles.length || oldFiles.some((file, index) => file !== snapshot.relativeFiles[index])) {
    const changedFiles = changedPaths(existingGraph.fileHashes, snapshot.fileHashes);
    return full("file-universe-changed", changedFiles);
  }
  const changedFiles = changedPaths(existingGraph.fileHashes, snapshot.fileHashes);
  if (!changedFiles.length) {
    return { graph: existingGraph, kind: "none", changedFiles: [], reason: "content-unchanged", revision: snapshot.revision, parsedFiles: [] };
  }
  if (changedFiles.length > maxChangedFiles) return full("changed-set-too-large", changedFiles);
  if (changedFiles.some((file) => CONFIG_RISK.test(file))) return full("config-manifest-or-alias-changed", changedFiles);
  if (changedFiles.some((file) => !JS_EXT.has(extname(file)))) return full("language-requires-full-context", changedFiles);
  for (const file of changedFiles) {
    if (isBarrelFile(existingGraph, file)) return full(`barrel-file-changed:${file}`, changedFiles);
    if (existingGraph.fileExportSignatures[file] !== snapshot.fileExportSignatures[file]) {
      return full(`export-surface-changed:${file}`, changedFiles);
    }
  }

  const importers = reverseImporters(existingGraph, changedFiles);
  const affected = [...new Set([...changedFiles, ...importers])].filter((file) => snapshot.fileHashes[file]).sort();
  if (affected.length > maxParsedFiles) return full("reverse-importer-set-too-large", changedFiles);
  try {
    const scoped = await builder(repoDir, {
      ...builderOptions,
      includeFiles: affected,
      baseGraph: existingGraph,
    });
    if (scoped.incrementalScope !== true) return full("builder-did-not-honor-incremental-scope", changedFiles);
    const graph = mergeScopedGraph(existingGraph, scoped, affected, snapshot);
    return {
      graph,
      kind: "incremental",
      changedFiles,
      reason: importers.size ? "changed-files-and-reverse-importers" : "changed-files-only",
      revision: snapshot.revision,
      parsedFiles: affected,
    };
  } catch {
    return full("incremental-merge-safety-fallback", changedFiles);
  }
}
