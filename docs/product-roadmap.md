# Public roadmap alignment

The canonical cross-product plan is the private Hosted
`docs/next-development-spec.md` dated 2026-07-16. This public note does not replace its release
sequence. It records where the API-contract work and the useful comparison findings belong.

Implementations are written independently from observed product requirements: no copied code and
no new dependency unless it materially improves measured results. This keeps the runtime and
third-party notice surface as small as practical; obligations for dependencies Weavatrix
intentionally ships still have to be honored.

## Shipped in Public 0.2.2: wrapper-aware API contracts

This work ships with `0.2.2` alongside, and without weakening, the regression foundation.

Delivered in `0.2.2`:

1. Built-in object clients such as `axios.get` and `httpClient.post`.
2. Configurable bare wrappers such as `get('/users')`.
3. Configurable fixed object/member wrappers and a zero-based URL argument position.
4. Conservative discovery of simple, unambiguous functions that directly forward a URL parameter
   to a known HTTP client, bounded to their import scope.
5. Best-effort route-handler resolution to an unambiguous graph node.
6. `NOT_DEAD_EXTERNAL_USE`, `POSSIBLE_EXTERNAL_USE`, and `UNKNOWN` endpoint liveness.
7. Method-level dead-candidate suppression only for a resolved handler node with medium/high
   confidence external evidence.

Evidence semantics are strict:

- static evidence can prove a use, but missing static evidence cannot prove non-use;
- low-confidence matches require review and never suppress a dead-code candidate;
- no cross-repository match remains `UNKNOWN`, never `DEAD`;
- caps, ambiguity, dynamic values and partial coverage are reported rather than guessed.

Still deferred to bounded follow-up work:

- static method-argument wrappers and object config such as `request({url, method})`;
- base-URL composition and supported generated-client adapters;
- privacy-safe contract identity in EvidenceSnapshot V2;
- Hosted endpoint-to-client ownership and company-wide liveness.

The paid value is not a hidden local detector. It is the controlled company join across separately
synced repositories: ownership, roles, scoped tokens, recovery, audit events and review routing.
That remains Hosted `0.4.0`, after the operational and evidence foundations.

## Fixed release sequence

### Public `0.2.2` — regression foundation

- Delivered foundation: permanent TS/JS/Python/Go/Java/Rust golden corpus and a source-free report
  schema shared by local tests and the release benchmark.
- Delivered foundation: byte, latency, freshness, reconnect and active-target gates against the
  real MCP stdio lifecycle.
- Delivered foundation: representative Java OOP and Rust module/endpoint assertions; the current
  golden gap lists are empty.
- Delivered layer: portable manifest-driven real-repository runner, exact 0.2.1 source-free
  baselines for all six release checkouts, a 5% unexplained-relation regression gate and explicit
  `MISSING`/`UNBASELINED`/`STALE` states. The strict six-repository release gate now passes while
  retaining honest incomplete states for an unavailable or stale checkout.
- Delivered: framework peer/build-tool and convention-consumer fixtures with negative controls.
- Delivered: versioned `EXACT_LSP` / `EXTRACTED` / `RESOLVED` / `INFERRED` / `CONFLICT`
  edge-provenance contract, complete golden/real gates, V3 sync allowlisting and current docs/skill.
- The 0.2.2 benchmark foundation added no large mandatory runtime dependency. Public 0.2.4 later
  added exact pinned TypeScript + `typescript-language-server` production dependencies for the
  bundled semantic provider, with npm/MCPB runtime and license gates.

The wrapper work above is covered by another cross-repository golden fixture and measured
endpoint-recall gate; it does not displace these deliverables. The executable contract is documented in
[`benchmarking.md`](benchmarking.md).

### Hosted `0.2.1` — operational workbench

- Real-browser visual/accessibility gate.
- Retention, pin, export and delete.
- Shared actionable lifecycle for Health, Direction and Duplicates.

### Public `0.2.5` — focused precision patch

- Delivered: on-demand exact TypeScript/JavaScript symbol inspection with grouped reference occurrences,
  graph blast radius and a bounded local source-context bundle. Point queries use a separate cache and
  never replace the broad safety-capped precision overlay.
- Delivered: conservative Python receiver-method dispatch and wildcard-import resolution, including
  lexical shadowing and ambiguity-negative fixtures.
- Delivered from the extended benchmark: default-object facade resolution, symbol-precise dependents,
  explicit unused-dependency evidence, test-only dead-symbol review, and opt-in small-clone scanning.
- Delivered: bounded offline `hot_path_review` with parser-derived local cost, exact inside-loop
  allocation/copy/scan/sort/recursion evidence, separate graph fan-in/fan-out risk, and measured
  coverage or explicitly labelled static test reachability.
- Interprocedural complexity and CFG/data-flow remain a separate next-version engine rather than an
  unbounded claim inside the local syntax model.
- Executable scope, tests and release gates: [`v0.2.5-development-plan.md`](v0.2.5-development-plan.md).

### Public `0.2.6` — compact context and TypeScript identities

- Delivered: bounded `context_bundle` output that aggregates graph relations into logical containers
  and combines them with exact point-query evidence and a small source workset.
- Delivered: line-addressable named, aliased, type-only and star re-export occurrences with resolved
  origin propagation through barrel chains.
- Delivered: separate TypeScript type/value graph identities, including merged-space classes and
  enums, with type-only references kept out of runtime call evidence.
- CFG reachability, data flow, taint/security analysis and interprocedural complexity remain a
  separately versioned hosted engine rather than claims attached to the local syntax graph.

### Public `0.2.7` — proof-carrying verified changes

- Delivered: one `verified_change` workflow with natural-language task retrieval, exact changed
  symbols, compact edit contexts, blast radius, immutable Git graph comparison, and explicit
  `PASS` / `BLOCKED` / `UNKNOWN` semantics.
- Delivered: architecture, new-duplicate and optional cross-repository HTTP-contract ratchets plus a
  double-opt-in allowlisted package-script test runner.
- Delivered: bounded JS/TS call-argument-to-parameter evidence. This is useful interprocedural data
  flow for edits, but does not claim CFG/value/taint completeness.
- Delivered: npm cache/release-snapshot exclusion in malware scanning and evidence-gated remediation.
- Delivered: heuristic malware severity capped at `high` without independent execution/advisory
  confirmation, with explicit verification state instead of compromise claims.
- Delivered: production-only `query_graph` traversal, low-signal constant/field suppression, focused
  hot-path defaults, dead-code evidence tiers, and per-finding dependency manifest/source proof.
- Delivered: an agent-task benchmark harness with local routing success, false-positive, token and
  latency metrics. External Codebase Memory and Serena results remain an independent-data release
  requirement rather than fabricated in-repository scores.

### Public `0.2.8` — trust and precision corrections

- Delivered: dead-code liveness reconciles same-file production use and revision-bound positive
  point-query evidence instead of reporting a symbol that exact inspection already proved used.
- Delivered: nearest-manifest ownership for nested Python requirements/pyproject/Pipfile layouts,
  including explicit unknown scope for sibling code that has no manifest.
- Delivered: comment-aware endpoint extraction and primitive path-map rejection for the two verified
  false-positive classes found during mixed-repository dogfooding.
- Delivered: Rust symbol kinds, ownership, visibility/export metadata and structural member edges.
- Delivered: explicit-language constraints in mixed-repository natural-language retrieval and
  decisive exact-reference summaries in compact `verified_change` output.
- Still next: Python/Rust/Java LSP providers, vector/semantic retrieval, CFG/value/taint analysis,
  runtime trace ingestion and a blind end-to-end competitor benchmark. Parser evidence is not
  relabelled as semantic proof.

### Public `0.2.9` — health/graph trust, REST correctness and explicit sync consent

- Delivered: nested Express `router.use(...)` composition in endpoint inventory, including relative
  ESM/CommonJS router imports, bounded multi-level mounts, declared/reachable counts and mount
  provenance; `trace_endpoint` binds one route to its handler and bounded production call graph.
- Delivered: edge-centered `context_bundle` provenance and source excerpts, plus repository-relative
  ripgrep path globs on Windows.
- Delivered: reduced natural-language seed noise for broad REST questions, production-first audit
  evidence, a dedicated dependency-health audit projection, and default suppression of homogeneous
  router clone boilerplate.
- Delivered: separate local-only `preview_sync`, exact short-lived payload confirmation,
  HTTPS/destination validation and actionable architecture-contract HTTP states.
- Delivered: transient per-call timing/output/freshness/cache metrics in MCP response metadata,
  without persistence, aggregation or egress.
- Delivered: public site, privacy/security/license, README and package-metadata alignment. Hosted UI
  and backend remain on their independent upgrade track; payload v3 stays wire-compatible and is
  checked against the Hosted contract suite.

### Public `0.3.0` — precision expansion

- Delivered early in 0.2.4: lazy local TS/JS LSP verification for bounded ambiguous edges and
  conservatively complete dead-code candidates, with explicit `COMPLETE`/`PARTIAL`/`UNAVAILABLE`/`OFF`
  states. This is not a clone of another tool surface.
- Next: Java pilot and broader exact-reference enrichment for architecture evidence; keep unsupported
  languages explicit instead of relabeling parser evidence as exact.
- Provenance/completeness contract and bounded Git-ref timeline/report API.

### Hosted `0.3.0` — EvidenceSnapshot V2

- Source-free Git-history trends and exact/inferred provenance.
- Target-editor/ratchet round trip, reconstructed release history and agent-readable decisions.

### Hosted `0.4.0` — company layer

- Organizations, roles, recovery, scoped tokens and immutable audit events.
- Company dependency/technology inventory and endpoint/event/database/package joins.
- Ownership and review routing; billing only after operational controls are complete.

## Comparison findings mapped without duplicating delivered work

- Hierarchical symbol identity feeds the delivered provenance contract and `0.3.0` precision; ambiguous
  same-name symbols must return candidates, never a silent guess.
- Focused TS/JS semantic no-reference verification shipped in 0.2.4. Broader framework/config/search,
  test and cross-repository liveness must remain part of the review before any deletion and is a
  precision-expansion target, not something an empty LSP result may silently replace.
- API contract diff belongs with bounded Git-ref history and later company evidence.
- Duplicate actionability belongs in Hosted `0.2.1` shared lifecycle; similarity detection already
  exists and should not be rebuilt.
- Trend analysis belongs in the bounded Git-native timeline planned for Public/Hosted `0.3.0`.
- External SARIF/security imports are an optional post-V2 adapter, not a new scanner project.
- Architecture baseline proposal, contract preparation and ratchet are already delivered; improve
  their measured evidence instead of introducing a duplicate feature name.

External semantic microscopes can remain comparison benchmarks, but are never a required runtime or
fallback. Weavatrix owns its TS/JS precision evidence alongside repo-wide analytics, Git
impact/history, architecture contracts and cross-repository/company evidence.
