import { folderModuleOf } from "../graph-analysis.edges.js";
import { isStructuralRelation } from "../../graph/relations.js";
import { endpointId, normalizeContractFile } from "./shared.js";

export function reverseRuntimeImports(graph = {}) {
  const byId = new Map();
  const files = new Set();
  for (const node of graph.nodes || []) {
    const file = normalizeContractFile(node?.source_file);
    if (!file) continue;
    byId.set(String(node.id), file);
    files.add(file);
  }
  const reverse = new Map([...files].map((file) => [file, new Set()]));
  for (const link of graph.links || []) {
    if (isStructuralRelation(link?.relation) || !["imports", "re_exports"].includes(link?.relation) || link?.typeOnly === true || link?.compileOnly === true || link?.barrelProxy === true) continue;
    const importer = byId.get(String(endpointId(link.source)));
    const imported = byId.get(String(endpointId(link.target)));
    if (!importer || !imported || importer === imported) continue;
    reverse.get(imported)?.add(importer);
  }
  return reverse;
}

export function wrapperScopeFiles(sourceFile, graph) {
  const source = normalizeContractFile(sourceFile);
  if (!source || !Array.isArray(graph?.nodes)) return null;
  const reverse = reverseRuntimeImports(graph);
  const allowed = new Set([source]);
  const queue = [{ file: source, depth: 0 }];
  while (queue.length && allowed.size < 2_000) {
    const current = queue.shift();
    if (current.depth >= 4) continue;
    for (const importer of [...(reverse.get(current.file) || [])].sort()) {
      if (allowed.has(importer)) continue;
      allowed.add(importer);
      queue.push({ file: importer, depth: current.depth + 1 });
    }
  }
  return allowed;
}

function isScreen(file) {
  const path = normalizeContractFile(file);
  const base = path.split("/").at(-1) || "";
  return /(^|\/)(pages?|screens?|views?|routes?)(\/|$)/i.test(path)
    || /(^|\/)(?:page|layout)\.[cm]?[jt]sx?$/i.test(path)
    || /^(?:App|Root)\.[cm]?[jt]sx?$/i.test(base);
}

export function affectedForEndpoint(callsites, clientContexts, limits) {
  const collected = new Map();
  let traversalTruncated = false;
  for (const context of clientContexts) {
    const seeds = callsites.filter((call) => call.clientRepo === context.id).map((call) => call.file).sort();
    if (!seeds.length) continue;
    const queue = [];
    const distance = new Map();
    for (const seed of seeds) if (!distance.has(seed)) { distance.set(seed, 0); queue.push(seed); }
    while (queue.length) {
      const file = queue.shift();
      const depth = distance.get(file);
      const key = `${context.id}\0${file}`;
      const previous = collected.get(key);
      if (!previous || depth < previous.distance) collected.set(key, { client: context.id, file, distance: depth });
      if (depth >= limits.maxImpactDepth) continue;
      for (const importer of [...(context.reverse.get(file) || [])].sort()) {
        if (distance.has(importer)) continue;
        if (distance.size >= limits.maxAffectedFiles * 2) { traversalTruncated = true; continue; }
        distance.set(importer, depth + 1);
        queue.push(importer);
      }
    }
  }
  const allFiles = [...collected.values()].sort((left, right) => left.distance - right.distance || left.client.localeCompare(right.client) || left.file.localeCompare(right.file));
  const filesTruncated = allFiles.length > limits.maxAffectedFiles;
  const files = allFiles.slice(0, limits.maxAffectedFiles);
  const allScreens = files.filter((entry) => isScreen(entry.file));
  const screensTruncated = allScreens.length > limits.maxScreens;
  const screens = allScreens.slice(0, limits.maxScreens);
  const moduleMap = new Map();
  for (const entry of files) {
    const module = folderModuleOf(entry.file);
    const key = `${entry.client}\0${module}`;
    const item = moduleMap.get(key) || { client: entry.client, module, files: 0, nearestDistance: entry.distance };
    item.files++;
    item.nearestDistance = Math.min(item.nearestDistance, entry.distance);
    moduleMap.set(key, item);
  }
  const allModules = [...moduleMap.values()].sort((left, right) => left.nearestDistance - right.nearestDistance || right.files - left.files || left.client.localeCompare(right.client) || left.module.localeCompare(right.module));
  const modulesTruncated = allModules.length > limits.maxModules;
  return {
    complete: !(traversalTruncated || filesTruncated || screensTruncated || modulesTruncated),
    files,
    screens,
    modules: allModules.slice(0, limits.maxModules),
    truncated: { traversal: traversalTruncated, files: filesTruncated, screens: screensTruncated, modules: modulesTruncated },
  };
}
const bareGraphLabel = (value) => String(value || "").replace(/\s*\(.*$/, "").replace(/[()]/g, "").trim();

export function handlerNodeEvidence(endpoint, graph) {
  const handler = /^[A-Za-z_$][\w$]{0,127}$/.test(String(endpoint?.handler || "")) ? String(endpoint.handler) : null;
  if (!handler) return { handler: null, handlerNodeId: null, handlerResolution: "inline-or-unresolved" };
  const nodes = graph?.nodes || [];
  const matches = nodes.filter((node) => normalizeContractFile(node?.source_file) && bareGraphLabel(node?.label) === handler && String(node?.id || "") !== normalizeContractFile(node?.source_file));
  const endpointFile = normalizeContractFile(endpoint.file);
  const sameFile = matches.filter((node) => normalizeContractFile(node?.source_file) === endpointFile);
  const byId = new Map(nodes.map((node) => [endpointId(node?.id), node]));
  const linkFile = (value) => {
    const id = endpointId(value);
    return normalizeContractFile(byId.get(id)?.source_file || String(id || "").split("#")[0]);
  };
  const directlyImportedFiles = new Set((graph?.links || [])
    .filter((link) => ["imports", "re_exports"].includes(link?.relation) && linkFile(link?.source) === endpointFile)
    .map((link) => linkFile(link?.target)).filter(Boolean));
  const imported = matches.filter((node) => directlyImportedFiles.has(normalizeContractFile(node?.source_file)));
  const resolved = sameFile.length === 1 ? sameFile[0] : imported.length === 1 ? imported[0] : matches.length === 1 ? matches[0] : null;
  return {
    handler,
    handlerNodeId: resolved ? String(resolved.id) : null,
    handlerResolution: resolved ? "resolved" : matches.length > 1 ? "ambiguous" : "unresolved",
  };
}

export function externalUseLiveness(callsites, handlerEvidence) {
  const proven = callsites.filter((call) => call.match?.confidence === "high" || call.match?.confidence === "medium");
  const possible = callsites.filter((call) => call.match?.confidence === "low");
  const status = proven.length ? "NOT_DEAD_EXTERNAL_USE" : possible.length ? "POSSIBLE_EXTERNAL_USE" : "UNKNOWN";
  const evidence = proven.length ? proven : possible;
  return {
    status,
    subject: handlerEvidence.handlerNodeId ? "handler-node" : handlerEvidence.handler ? "endpoint-handler" : "endpoint",
    canSuppressDeadCandidate: proven.length > 0 && Boolean(handlerEvidence.handlerNodeId),
    staticEvidence: evidence.length,
    consumerRepositories: [...new Set(evidence.map((call) => call.clientRepo))].sort(),
    reason: proven.length
      ? "At least one selected external repository has a medium/high-confidence static HTTP contract match."
      : possible.length
        ? "Only low-confidence external HTTP contract matches were found; review before suppressing a dead-code candidate."
        : "No selected external repository proved a static caller; absence of evidence is not a dead-code verdict.",
  };
}
