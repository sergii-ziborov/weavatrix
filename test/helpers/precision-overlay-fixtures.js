import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {snapshotRepository} from '../../src/graph/incremental-refresh.js'

export const fileNode = (file) => ({ id: file, label: file, source_file: file, file_type: "code" });
export const symbolNode = (file, name, line, end = line, extra = {}) => ({
  id: `${file}#${name}@${line}`,
  label: `${name}()`,
  source_file: file,
  source_location: `L${line}`,
  source_end: `L${end}`,
  source_range: {
    start: { line: line - 1, character: 0 },
    end: { line: end - 1, character: 1_000 },
  },
  selection_start: { line: line - 1, character: 16 },
  symbol_kind: "function",
  ...extra,
});

export const withSnapshot = (root, graph) => ({...graph, fileHashes: snapshotRepository(root).fileHashes});

export function fixtureGraph(mode = "full") {
  const caller = symbolNode("src/caller.ts", "realCaller", 2, 4, { exported: true });
  const decoy = symbolNode("src/decoy.ts", "decoyCaller", 2, 4, { exported: true });
  const target = symbolNode("src/target.ts", "target", 1, 1);
  return {
    graphRevision: "revision-a",
    graphBuildMode: mode,
    nodes: [
      fileNode("src/caller.ts"),
      fileNode("src/decoy.ts"),
      fileNode("src/target.ts"),
      caller,
      decoy,
      target,
    ],
    links: [
      { source: "src/caller.ts", target: caller.id, relation: "contains", provenance: "EXTRACTED" },
      { source: "src/decoy.ts", target: decoy.id, relation: "contains", provenance: "EXTRACTED" },
      { source: "src/target.ts", target: target.id, relation: "contains", provenance: "EXTRACTED" },
      { source: caller.id, target: target.id, relation: "calls", line: 3, provenance: "INFERRED" },
      { source: decoy.id, target: target.id, relation: "calls", line: 3, provenance: "INFERRED" },
    ],
  };
}

export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-precision-overlay-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }));
  writeFileSync(join(root, "src", "caller.ts"), "export function realCaller() {\n  return target();\n}\n");
  writeFileSync(join(root, "src", "decoy.ts"), "export function decoyCaller() {\n  return target();\n}\n");
  writeFileSync(join(root, "src", "target.ts"), "export function target() {}\n");
  writeFileSync(join(root, "test", "target.test.ts"), "target();\n");
  return root;
}

