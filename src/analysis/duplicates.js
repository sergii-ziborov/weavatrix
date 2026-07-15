// duplicates.js — content-based clone detection over the repo's OWN graph.json symbols (the Health
// tab's engine). MOSS-style pipeline: symbol bodies (line ranges from the graph) → strip comments &
// string bodies → tokenize → k-gram rolling hashes → winnowing fingerprints → inverted index (no
// O(n²) all-pairs) → jaccard similarity. BOTH normalization modes are computed in one pass so every
// UI knob (similarity %, min size, strict/renamed) filters instantly on the renderer side:
//   strict  — identifiers kept: only literal copy-paste (Type-1 clones)
//   renamed — identifiers canonicalized to "I": catches copy-paste-then-rename (Type-2 clones)
// Pairs are reported down to the FLOOR values; the renderer slices from there upward.
//
// Facade: the implementation lives in the sibling modules —
//   duplicates.tokenize.js — stripping, body-end detection, tokenization, winnowing fingerprints
//   duplicates.compute.js  — fragment extraction, inverted-index pairing, computeDuplicates
//   duplicates.run.js      — worker offload + mtime cache (runDuplicates entry)
export { computeDuplicates } from "./duplicates.compute.js";
export { runDuplicates } from "./duplicates.run.js";
