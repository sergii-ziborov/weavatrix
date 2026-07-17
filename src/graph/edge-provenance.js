// Versioned origin classification for graph edges. `confidence` remains a compatibility field;
// provenance says how an edge was established and leaves room for a bounded LSP precision overlay.
export const EDGE_PROVENANCE_V = 1;
export const EDGE_PROVENANCE_KINDS = Object.freeze([
  "EXACT_LSP", "EXTRACTED", "RESOLVED", "INFERRED", "CONFLICT",
]);

const ALLOWED = new Set(EDGE_PROVENANCE_KINDS);

export function edgeProvenance(edge) {
  const explicit = String(edge?.provenance || "").trim().toUpperCase();
  if (ALLOWED.has(explicit)) return explicit;
  if (edge?.semanticOrigin === true) return "RESOLVED";
  const legacy = String(edge?.confidence || "").trim().toUpperCase();
  return ALLOWED.has(legacy) ? legacy : "UNKNOWN";
}

export function stampEdgeProvenance(links) {
  for (const link of Array.isArray(links) ? links : []) {
    const provenance = edgeProvenance(link);
    if (provenance !== "UNKNOWN") link.provenance = provenance;
  }
  return links;
}

export function summarizeEdgeProvenance(links) {
  const counts = Object.fromEntries([...EDGE_PROVENANCE_KINDS, "UNKNOWN"].map((kind) => [kind, 0]));
  for (const link of Array.isArray(links) ? links : []) counts[edgeProvenance(link)] += 1;
  const total = Array.isArray(links) ? links.length : 0;
  return {version: EDGE_PROVENANCE_V, total, classified: total - counts.UNKNOWN, complete: counts.UNKNOWN === 0, counts};
}
