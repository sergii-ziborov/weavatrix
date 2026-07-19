import { createRepoBoundary } from "../repo-path.js";
import { lineNumberAt, uniqueBy } from "../util.js";
import { listRepoFiles, readRepoText } from "./internal-audit/repo-files.js";
import { affectedForEndpoint, reverseRuntimeImports } from "./http-contracts/graph-context.js";

const TEST_RE = /(^|\/)(?:test|tests|__tests__|spec|e2e|fixtures?)(\/|$)|[._-](?:test|spec)\.[a-z0-9]+$/i;
const SOURCE_RE = /\.(?:[cm]?[jt]sx?|py|go|java|rs|cs|proto|graphql|gql)$/i;
const lineAt = lineNumberAt;
const norm = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function sourcesFor(descriptor, { includeTests, maxFiles }) {
  const boundary = createRepoBoundary(descriptor.repoRoot);
  if (!boundary.root) return { sources: [], reasons: [`${descriptor.id}: repository boundary is unreadable`] };
  const candidates = listRepoFiles(boundary.root).filter((file) => SOURCE_RE.test(file) && (includeTests || !TEST_RE.test(file))).sort();
  const sources = [];
  for (const file of candidates.slice(0, maxFiles)) {
    const text = readRepoText(boundary, file);
    if (text != null) sources.push({ file, text });
  }
  return { sources, reasons: candidates.length > maxFiles ? [`${descriptor.id}: transport file cap reached`] : [] };
}

function graphQlEvidence(source, role) {
  const contracts = [], uncertain = [];
  for (const schema of source.text.matchAll(/\btype\s+(Query|Mutation|Subscription)\s*(?:extends\s+\w+\s*)?\{([\s\S]*?)\}/gi)) {
    for (const field of schema[2].matchAll(/^\s*([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/gm)) contracts.push({
      transport: "graphql", side: "server", operation: schema[1].toUpperCase(), name: field[1], file: source.file,
      line: lineAt(source.text, schema.index + schema[0].indexOf(field[0])), detector: "graphql-schema",
    });
  }
  for (const operation of source.text.matchAll(/\b(query|mutation|subscription)\s*(?:[A-Za-z_]\w*\s*)?(?:\([^)]*\)\s*)?\{\s*([A-Za-z_]\w*)/gi)) contracts.push({
    transport: "graphql", side: role === "backend" ? "server-call" : "client", operation: operation[1].toUpperCase(), name: operation[2],
    file: source.file, line: lineAt(source.text, operation.index), detector: "graphql-operation",
  });
  for (const dynamic of source.text.matchAll(/\b(?:gql|graphql)\s*(?:\(|`)\s*\$\{|\b(?:query|mutate)\s*\(\s*(?!["'`])/gi)) uncertain.push({
    transport: "graphql", file: source.file, line: lineAt(source.text, dynamic.index), reason: "GraphQL document or operation is runtime-computed",
  });
  return { contracts, uncertain };
}

function grpcEvidence(source, role) {
  const contracts = [], uncertain = [], aliases = new Map();
  for (const service of source.text.matchAll(/\bservice\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/g)) {
    for (const rpc of service[2].matchAll(/\brpc\s+([A-Za-z_]\w*)\s*\(/g)) contracts.push({
      transport: "grpc", side: "server", service: service[1], name: rpc[1], file: source.file,
      line: lineAt(source.text, service.index + service[0].indexOf(rpc[0])), detector: "proto-service",
    });
  }
  const aliasPatterns = [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_]\w*(?:Service)?Client)\b/g,
    /\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*Stub)\s*\(/g,
    /\b([A-Za-z_]\w*)\s*:?=\s*\w*\.New([A-Za-z_]\w*)Client\s*\(/g,
    /\b(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*(?:Blocking|Future|Async)?Stub)\s+([A-Za-z_]\w*)\s*[=;]/g,
  ];
  for (const [index, pattern] of aliasPatterns.entries()) for (const match of source.text.matchAll(pattern)) {
    const alias = index === 3 ? match[2] : match[1];
    const type = index === 3 ? match[1] : match[2];
    aliases.set(alias, type.replace(/(?:Service)?Client$|(?:Blocking|Future|Async)?Stub$/i, ""));
  }
  for (const call of source.text.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\.|->)\s*([A-Za-z_]\w*)\s*\(/g)) {
    if (!aliases.has(call[1])) continue;
    contracts.push({ transport: "grpc", side: role === "backend" ? "server-call" : "client", service: aliases.get(call[1]), name: call[2], file: source.file, line: lineAt(source.text, call.index), detector: "grpc-stub-call" });
  }
  for (const dynamic of source.text.matchAll(/\b(?:ServerReflection|ProtoReflection|grpc\.reflection|Class\.forName|Method\.invoke|reflect\.Value|dynamicStub)\b/g)) uncertain.push({
    transport: "grpc", file: source.file, line: lineAt(source.text, dynamic.index), reason: "gRPC/reflection target is runtime-resolved",
  });
  return { contracts, uncertain };
}

function eventEvidence(source, role) {
  const contracts = [], uncertain = [];
  const add = (side, kind, match, topicIndex = 2) => contracts.push({
    transport: "event", side, kind, name: match[topicIndex], file: source.file, line: lineAt(source.text, match.index), detector: "static-topic",
  });
  const subscriptions = [
    /\b(?:consumer|kafka|bus|events?|eventBus)\s*(?:\.|->)\s*(subscribe|on|consume)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /@KafkaListener\s*\([^)]*\btopics?\s*=\s*["']([^"']+)["']/gi,
    /\bsubscribe\s*\(\s*\{\s*topic\s*:\s*["'`]([^"'`]+)["'`]/gi,
  ];
  for (const [index, pattern] of subscriptions.entries()) for (const match of source.text.matchAll(pattern)) add("subscriber", index === 0 ? match[1] : "subscribe", match, index === 0 ? 2 : 1);
  const publications = [
    /\b(?:producer|kafka|bus|events?|eventBus|kafkaTemplate)\s*(?:\.|->)\s*(publish|emit|send|produce)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:producer|kafka)\s*(?:\.|->)\s*send\s*\(\s*\{\s*topic\s*:\s*["'`]([^"'`]+)["'`]/gi,
  ];
  for (const [index, pattern] of publications.entries()) for (const match of source.text.matchAll(pattern)) add("publisher", index === 0 ? match[1] : "send", match, index === 0 ? 2 : 1);
  for (const dynamic of source.text.matchAll(/\b(?:subscribe|publish|emit|consume|produce)\s*\(\s*(?!["'`{])([A-Za-z_$][\w$]*)/gi)) uncertain.push({
    transport: "event", file: source.file, line: lineAt(source.text, dynamic.index), reason: `Event topic is runtime-computed (${dynamic[1]})`, role,
  });
  return { contracts, uncertain };
}

function detect(descriptor, role, options) {
  const loaded = sourcesFor(descriptor, options), contracts = [], uncertain = [];
  for (const source of loaded.sources) {
    for (const detector of [graphQlEvidence, grpcEvidence, eventEvidence]) {
      const result = detector(source, role);
      contracts.push(...result.contracts); uncertain.push(...result.uncertain);
    }
  }
  return {
    contracts: uniqueBy(contracts, (item) => `${item.transport}|${item.side}|${item.service || ""}|${item.operation || ""}|${item.name}|${item.file}|${item.line}`),
    uncertain: uniqueBy(uncertain, (item) => `${item.transport}|${item.file}|${item.line}|${item.reason}`),
    reasons: loaded.reasons,
    filesScanned: loaded.sources.length,
  };
}

function contractMatch(server, caller, backendServers) {
  if (server.transport !== caller.transport) return null;
  if (server.transport === "graphql" && caller.side === "client" && server.operation === caller.operation && server.name === caller.name) return { confidence: "high", kind: "operation-field" };
  if (server.transport === "grpc" && caller.side === "client" && norm(server.name) === norm(caller.name)) {
    if (caller.service && norm(server.service) === norm(caller.service)) return { confidence: "high", kind: "service-method" };
    const sameMethod = backendServers.filter((item) => item.transport === "grpc" && norm(item.name) === norm(caller.name));
    if (!caller.service && sameMethod.length === 1) return { confidence: "medium", kind: "unique-method" };
  }
  if (server.transport === "event" && server.name === caller.name && server.side !== caller.side) return { confidence: "high", kind: "topic-direction" };
  return null;
}

export function analyzeTransportContracts(input = {}) {
  const transport = ["all", "graphql", "grpc", "event"].includes(input.transport) ? input.transport : "all";
  const options = { includeTests: input.includeTests === true, maxFiles: Math.max(1, Math.min(10_000, Number(input.maxFiles) || 3_000)) };
  const backend = detect(input.backend, "backend", options);
  const clients = (input.clients || []).map((descriptor) => ({ descriptor, evidence: detect(descriptor, "client", options), reverse: reverseRuntimeImports(descriptor.graph) }));
  const selected = (item) => transport === "all" || item.transport === transport;
  const backendContracts = backend.contracts.filter(selected);
  const servers = backendContracts.filter((item) => item.side === "server" || item.transport === "event");
  const results = [];
  for (const server of servers) {
    const callsites = [];
    for (const client of clients) for (const caller of client.evidence.contracts.filter(selected)) {
      const match = contractMatch(server, caller, servers);
      if (!match) continue;
      callsites.push({ clientRepo: client.descriptor.id, file: caller.file, line: caller.line, detector: caller.detector, match });
    }
    const affected = affectedForEndpoint(callsites, clients.map((item) => ({ id: item.descriptor.id, reverse: item.reverse })), {
      maxImpactDepth: Math.max(0, Math.min(5, Number(input.maxImpactDepth) || 2)),
      maxAffectedFiles: Math.max(1, Math.min(500, Number(input.maxAffectedFiles) || 100)), maxScreens: 50, maxModules: 50,
    });
    results.push({ ...server, callsites, affected, liveness: callsites.length ? "NOT_DEAD_EXTERNAL_USE" : "UNKNOWN" });
  }
  const uncertain = [
    ...backend.uncertain.map((item) => ({ repository: input.backend.id, ...item })),
    ...clients.flatMap((item) => item.evidence.uncertain.map((entry) => ({ repository: item.descriptor.id, ...entry }))),
  ].filter(selected);
  const reasons = [...backend.reasons, ...clients.flatMap((item) => item.evidence.reasons)];
  if (uncertain.length) reasons.push(`${uncertain.length} dynamic/reflection contract expression(s) remain UNKNOWN`);
  return {
    transportContractsV: 1,
    transport,
    status: reasons.length ? "PARTIAL" : "COMPLETE",
    completeness: { complete: reasons.length === 0, reasons: [...new Set(reasons)] },
    totals: { contracts: results.length, matches: results.reduce((sum, item) => sum + item.callsites.length, 0), uncertain: uncertain.length, filesScanned: backend.filesScanned + clients.reduce((sum, item) => sum + item.evidence.filesScanned, 0) },
    contracts: results,
    uncertain: uncertain.slice(0, 200),
  };
}
