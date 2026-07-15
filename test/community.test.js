import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { communityTerritoryOf } from "../src/graph/community.js";
import { summarizeCommunities, summarizeHotspots } from "../src/analysis/graph-analysis.summaries.js";

test("Java Maven/Gradle communities retain package territory beyond src/main/java", () => {
  assert.equal(
    communityTerritoryOf("application/src/main/java/com/edgehawk/warroom/application/handlers/AlertHandler.java"),
    "application/src/main/java/com/edgehawk/warroom/application/handlers",
  );
  assert.equal(
    communityTerritoryOf("application/src/test/java/com/edgehawk/warroom/application/handlers/AlertHandlerTest.java"),
    "application/src/test/java/com/edgehawk/warroom/application/handlers",
  );
});

test("non-Java community buckets keep the historical top-two-folder behavior", () => {
  assert.equal(communityTerritoryOf("watcher-rs/src/api/routes.rs"), "watcher-rs/src");
  assert.equal(communityTerritoryOf("src/main.ts"), "src");
  assert.equal(communityTerritoryOf("index.js"), "(root)");
});

test("community summaries name Java groups by their package territory", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-community-"));
  const graphPath = join(dir, "graph.json");
  const file = "application/src/main/java/com/edgehawk/warroom/model/DocumentAttack.java";
  writeFileSync(graphPath, JSON.stringify({ nodes: [{ id: file, file_type: "code", source_file: file, community: 7 }] }));
  try {
    assert.equal(summarizeCommunities(graphPath)[0].name, "application/src/main/java/com/edgehawk/warroom/model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hotspot summaries exclude Java ownership but retain real calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-hotspot-"));
  const graphPath = join(dir, "graph.json");
  const nodes = [
    { id: "A.java#A@1", label: "A", file_type: "code", source_file: "A.java" },
    { id: "A.java#work@2", label: "work()", file_type: "code", source_file: "A.java" },
    { id: "B.java#call@1", label: "call()", file_type: "code", source_file: "B.java" },
  ];
  writeFileSync(graphPath, JSON.stringify({ nodes, links: [
    { source: nodes[0].id, target: nodes[1].id, relation: "method" },
    { source: nodes[2].id, target: nodes[1].id, relation: "calls" },
  ] }));
  try {
    const hotspots = summarizeHotspots(graphPath);
    assert.ok(!hotspots.some((entry) => entry.label === "A"));
    assert.deepEqual(hotspots.map((entry) => [entry.label, entry.degree]), [["work()", 1], ["call()", 1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
