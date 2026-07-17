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
  baselines for five available checkouts, a 5% unexplained-relation regression gate and explicit
  `MISSING`/`UNBASELINED`/`STALE` states. The Rust source checkout is still unavailable locally, so
  the strict six-repository release gate correctly remains incomplete.
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
