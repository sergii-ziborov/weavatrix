// Reading a built graph.json and summarizing it for the UI cards: named communities and degree
// hotspots. Both read the graph file from disk and return [] on any failure.
import { readFileSync } from "node:fs";
import { communityTerritoryOf } from "../graph/community.js";
import { isStructuralRelation } from "../graph/relations.js";

// graph-builder labels communities "Community N" without an LLM. Derive a real name from each
// community's dominant folder + sample files so the UI shows modules, not bare numbers.
export function summarizeCommunities(graphJsonPath, max = 40) {
  try {
    const graph = JSON.parse(readFileSync(graphJsonPath, "utf8"));
    const byCommunity = new Map();
    for (const node of graph.nodes || []) {
      if (node.file_type !== "code") continue;
      const community = node.community;
      if (community === undefined || community === null) continue;
      if (!byCommunity.has(community)) byCommunity.set(community, { id: community, size: 0, dirs: new Map(), files: [] });
      const entry = byCommunity.get(community);
      entry.size += 1;
      const parts = String(node.source_file || "").split(/[\\/]/).filter(Boolean);
      const dir = communityTerritoryOf(node.source_file);
      entry.dirs.set(dir, (entry.dirs.get(dir) || 0) + 1);
      if (entry.files.length < 4) entry.files.push(parts[parts.length - 1] || node.source_file || "");
    }
    return [...byCommunity.values()]
      .map((entry) => {
        const dominant = [...entry.dirs.entries()].sort((left, right) => right[1] - left[1])[0];
        return { id: entry.id, size: entry.size, name: dominant ? dominant[0] : "(mixed)", files: entry.files };
      })
      .sort((left, right) => right.size - left.size)
      .slice(0, max);
  } catch {
    return [];
  }
}

// Top nodes by total degree (in+out) — the "load-bearing" / refactor-candidate hotspots.
export function summarizeHotspots(graphJsonPath, max = 15) {
  try {
    const graph = JSON.parse(readFileSync(graphJsonPath, "utf8"));
    const nodes = graph.nodes || [];
    const endpoint = (value) => (value && typeof value === "object" ? value.id : value);
    const inDeg = new Map();
    const outDeg = new Map();
    for (const link of graph.links || []) {
      if (isStructuralRelation(link.relation)) continue;
      const s = endpoint(link.source);
      const t = endpoint(link.target);
      outDeg.set(s, (outDeg.get(s) || 0) + 1);
      inDeg.set(t, (inDeg.get(t) || 0) + 1);
    }
    return nodes
      .filter((node) => node.file_type === "code")
      .map((node) => {
        const inbound = inDeg.get(node.id) || 0;
        const outbound = outDeg.get(node.id) || 0;
        return { label: node.label || node.norm_label || node.id, file: node.source_file || "", in: inbound, out: outbound, degree: inbound + outbound };
      })
      .filter((node) => node.degree > 0)
      .sort((left, right) => right.degree - left.degree)
      .slice(0, max);
  } catch {
    return [];
  }
}
