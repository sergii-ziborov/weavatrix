import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createRepoBoundary, isPathInside } from "../repo-path.js";

const TRANSPORT_RUNTIME_SCHEMA = "weavatrix.transport-runtime.v1";
const TRANSPORTS = ["graphql", "grpc", "event"];
const DEFAULT_REPORTS = [
  ".weavatrix/transport-runtime.json",
  ".weavatrix/reports/transport-runtime.json",
];
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVATIONS = 10_000;

const text = (value, max = 256) => typeof value === "string" ? value.trim().slice(0, max) : "";
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined;

function requestedTransports(transport) {
  return TRANSPORTS.includes(transport) ? [transport] : TRANSPORTS;
}

function reportPath(descriptor, candidate) {
  const boundary = createRepoBoundary(descriptor.repoRoot);
  const resolved = boundary.resolve(candidate);
  return resolved.ok ? { boundary, path: resolved.path } : { boundary, reason: resolved.reason };
}

function safeSourceFile(descriptor, value) {
  const raw = text(value, 1024).replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return undefined;
  if (!isAbsolute(raw) && !raw.startsWith("../") && !raw.includes("/../")) return raw.replace(/^\.\//, "");
  const root = resolve(descriptor.repoRoot);
  const target = resolve(raw);
  return isPathInside(root, target) ? relative(root, target).replace(/\\/g, "/") : undefined;
}

function attributeValue(attribute) {
  const value = attribute?.value ?? attribute;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (value?.[key] !== undefined) return value[key];
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function attributes(input) {
  const out = new Map();
  for (const item of Array.isArray(input) ? input : []) if (typeof item?.key === "string") out.set(item.key, attributeValue(item));
  return out;
}

function spanSide(span, transport) {
  const kind = String(span?.kind ?? "").toUpperCase();
  const numeric = Number(span?.kind);
  if (transport === "event") {
    if (kind.includes("PRODUCER") || numeric === 4) return "publisher";
    if (kind.includes("CONSUMER") || numeric === 5) return "subscriber";
  }
  if (kind.includes("SERVER") || numeric === 2) return "server";
  if (kind.includes("CLIENT") || numeric === 3) return "client";
  return "";
}

function observationFromSpan(descriptor, span) {
  const attrs = attributes(span?.attributes);
  const common = {
    file: safeSourceFile(descriptor, attrs.get("code.file.path") ?? attrs.get("code.filepath")),
    line: number(attrs.get("code.line.number") ?? attrs.get("code.lineno")),
    observedCount: 1,
    detector: "otlp-span",
  };
  const rpcSystem = text(attrs.get("rpc.system")).toLowerCase();
  if (rpcSystem === "grpc") {
    const fallback = text(span?.name).split("/").filter(Boolean);
    return { ...common, transport: "grpc", side: spanSide(span, "grpc"), service: text(attrs.get("rpc.service")) || fallback.at(-2), name: text(attrs.get("rpc.method")) || fallback.at(-1) };
  }
  const graphOperation = text(attrs.get("graphql.operation.type")).toUpperCase();
  const graphField = text(attrs.get("graphql.field.name") ?? attrs.get("graphql.field"));
  if (graphOperation || graphField) return { ...common, transport: "graphql", side: spanSide(span, "graphql"), operation: graphOperation, name: graphField };
  const messagingSystem = text(attrs.get("messaging.system")).toLowerCase();
  const destination = text(attrs.get("messaging.destination.name") ?? attrs.get("messaging.destination"));
  if (messagingSystem || destination) return { ...common, transport: "event", side: spanSide(span, "event"), kind: text(attrs.get("messaging.operation.type") ?? attrs.get("messaging.operation")), name: destination };
  return null;
}

function otlpObservations(descriptor, report) {
  const root = report.otlp && typeof report.otlp === "object" ? report.otlp : report;
  const out = [];
  for (const resource of Array.isArray(root.resourceSpans) ? root.resourceSpans : []) {
    const scopes = resource.scopeSpans ?? resource.instrumentationLibrarySpans ?? [];
    for (const scope of scopes) for (const span of Array.isArray(scope.spans) ? scope.spans : []) {
      const observation = observationFromSpan(descriptor, span);
      if (observation) out.push(observation);
    }
  }
  return out;
}

function normalizeObservation(descriptor, raw) {
  const transport = text(raw?.transport).toLowerCase();
  const side = text(raw?.side).toLowerCase();
  const name = text(raw?.name);
  if (!TRANSPORTS.includes(transport) || !name) return null;
  const allowedSides = transport === "event" ? ["publisher", "subscriber"] : ["server", "client", "server-call"];
  if (!allowedSides.includes(side)) return null;
  const operation = text(raw?.operation).toUpperCase();
  if (transport === "graphql" && !["QUERY", "MUTATION", "SUBSCRIPTION"].includes(operation)) return null;
  const line = number(raw?.line);
  return {
    transport, side, name,
    ...(operation ? { operation } : {}),
    ...(text(raw?.service) ? { service: text(raw.service) } : {}),
    ...(text(raw?.kind) ? { kind: text(raw.kind) } : {}),
    ...(safeSourceFile(descriptor, raw?.file) ? { file: safeSourceFile(descriptor, raw.file) } : {}),
    ...(line > 0 && line <= 10_000_000 ? { line: Math.floor(line) } : {}),
    observedCount: Math.max(1, Math.min(1_000_000_000, Math.floor(number(raw?.observedCount) || 1))),
    detector: text(raw?.detector) || "runtime-report",
    runtimeObserved: true,
  };
}

function validateReport(descriptor, report, options, file) {
  const reasons = [];
  let usable = true;
  if (report?.schema !== TRANSPORT_RUNTIME_SCHEMA) { reasons.push(`${descriptor.id}: unsupported runtime evidence schema`); usable = false; }
  if (!descriptor.graph?.graphRevision || report?.repositoryRevision !== descriptor.graph.graphRevision) { reasons.push(`${descriptor.id}: runtime evidence revision does not match the active graph`); usable = false; }
  const generatedAt = Date.parse(report?.generatedAt);
  const now = Number(options.now ?? Date.now());
  const maxAgeMs = Math.max(1, Math.min(8760, Number(options.maxAgeHours) || 168)) * 3_600_000;
  if (!Number.isFinite(generatedAt)) { reasons.push(`${descriptor.id}: runtime evidence generatedAt is invalid`); usable = false; }
  else if (generatedAt > now + 300_000 || now - generatedAt > maxAgeMs) { reasons.push(`${descriptor.id}: runtime evidence is stale or from the future`); usable = false; }
  const selected = requestedTransports(options.transport);
  const coverage = Object.fromEntries(selected.map((item) => [item, String(report?.coverage?.[item] || "NOT_CHECKED").toUpperCase()]));
  for (const [item, status] of Object.entries(coverage)) if (status !== "COMPLETE") reasons.push(`${descriptor.id}: ${item} runtime capture is ${status}`);
  const raw = [...(Array.isArray(report?.observations) ? report.observations : []), ...otlpObservations(descriptor, report)].slice(0, MAX_OBSERVATIONS);
  const observations = usable ? raw.map((item) => normalizeObservation(descriptor, item)).filter(Boolean) : [];
  if (raw.length !== observations.length) reasons.push(`${descriptor.id}: ${raw.length - observations.length} invalid runtime observation(s) were ignored`);
  return { status: reasons.length ? "PARTIAL" : "COMPLETE", file, generatedAt: report?.generatedAt, repositoryRevision: report?.repositoryRevision, coverage, observations, reasons };
}

export function loadTransportRuntimeEvidence(descriptor, options = {}) {
  const candidates = options.file ? [String(options.file)] : DEFAULT_REPORTS;
  for (const candidate of candidates) {
    const resolved = reportPath(descriptor, candidate);
    if (!resolved.path) {
      if (options.file) return { status: "ERROR", file: candidate, coverage: {}, observations: [], reasons: [`${descriptor.id}: runtime evidence path is ${resolved.reason}`] };
      continue;
    }
    try {
      if (statSync(resolved.path).size > MAX_REPORT_BYTES) return { status: "ERROR", file: candidate, coverage: {}, observations: [], reasons: [`${descriptor.id}: runtime evidence exceeds ${MAX_REPORT_BYTES} bytes`] };
      return validateReport(descriptor, JSON.parse(readFileSync(resolved.path, "utf8")), options, candidate);
    } catch {
      return { status: "ERROR", file: candidate, coverage: {}, observations: [], reasons: [`${descriptor.id}: runtime evidence is unreadable or invalid JSON`] };
    }
  }
  return { status: "NOT_CHECKED", file: null, coverage: {}, observations: [], reasons: [`${descriptor.id}: no revision-bound runtime transport evidence was found`] };
}
