// internal-audit.js — façade over the internal analyzers: loads a repo's graph.json + package.json,
// runs dead-check (files) + computeUnusedExports + dep-check, and emits the unified findings envelope
// (DEPS_SECURITY_PLAN.md §2.2-2.3). ALL filesystem access lives here; the analyzers stay pure.
// P2 will add dep-rules (cycles/orphans/boundary); the security/ analyzers join in P4-P5.
// Split: fs collection helpers live in internal-audit.collect.js, reachability in
// internal-audit.reach.js, and the audit runner in internal-audit.run.js — this file
// re-exports the public surface so external import paths keep working unchanged.
export { collectSourceTexts } from "./internal-audit.collect.js";
export { runInternalAudit } from "./internal-audit.run.js";
