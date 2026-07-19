---
name: weavatrix
description: "Use the Weavatrix MCP as a reusable local repository-intelligence layer: understand unfamiliar applications with a bounded code graph, reduce repeated context, review Health, dead code, duplicates and history, trace endpoints and blast radius, enforce target architecture, and verify changes before a PR."
---

# weavatrix MCP

Structure-analysis tools over a prebuilt code graph plus the weavatrix analysis engines. The default
`offline` profile has every HTTP tool disabled and permits repository switching only through an
explicit local `open_repo` call. Use `pinned` when a shared MCP process must never change or inspect
outside its startup repository.

## Step 0 — if the tools are missing

Tools are named `mcp__weavatrix__…`. If none are available, ask the user to register the server
(`claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot>`; Codex:
`codex mcp add weavatrix -- npx -y weavatrix <repoRoot>`), then retry.

First compare the selected profile with the `graph_stats` runtime line. Expected catalogs are 31
tools for `pinned`, 34 for `offline`, 35 for `osv`, and 38 for `hosted` / `full`. Weavatrix refuses
`initialize`, `tools/list`, and tool calls when the running package version differs from the
`package.json` version on disk, with a loud `STALE_RUNTIME` error; restart/reconnect rather than using
an old daemon. `WEAVATRIX_ALLOW_STALE_RUNTIME=1` is only for deliberate source development. A custom
capability list needs `crossrepo` for `trace_api_contract`; legacy `online` adds only
`advisories,hosted`. Missing HTTP tools are intentional only when the selected profile excludes them.

Profiles use the same npm package and binary:

- `offline` (default): all local analysis and explicit `open_repo`; no HTTP tools.
- `pinned`: local analysis with no `open_repo`, no global/cross-repository graph access, and no HTTP tools.
- `osv`: `offline` plus explicit `refresh_advisories`.
- `hosted` / `full`: `osv` plus local-only `preview_sync` and the explicitly invoked network tools
  `pull_architecture_contract` and confirmed `sync_graph`.

The legacy `online` capability remains a compatibility alias for `advisories,hosted`; prefer the
named profiles for new registrations.

## Intent router

Weavatrix is not one report or three fixed workflows. Its 38 methods expose different bounded views
and analyses over the same reusable graph. Start from the task and choose the smallest sufficient
projection; expand only when the answer requires it.

### Graph views and application understanding

- **Confirm repository, graph freshness and build mode**: `graph_stats`; use `rebuild_graph` only for
  a reported fallback/error or an intentional mode/precision change.
- **Switch or inventory local repositories**: `list_known_repos` -> `open_repo` -> `graph_stats`.
- **See production module topology**: `module_map`; use this first for a large unfamiliar application.
- **See discovered communities and their members**: `list_communities` -> `get_community`.
- **Find high-coupling hubs**: `god_nodes`; repeated call sites do not inflate unique connectivity.
- **Inspect one graph entity**: `get_node`; pass an exact node ID when labels are ambiguous.
- **Inspect direct one-hop relations**: `get_neighbors`; do not confuse it with transitive impact.
- **Find a connectivity path between two concepts**: `shortest_path`. It traverses the graph as
  undirected reachability, so it is not proof of call/dependency direction; confirm direction with
  `get_neighbors` and `read_source`.
- **Explore an unknown entry point or architectural question**: `query_graph`; pin `seed_files` or
  exact `seed_symbols` when known. Use `relation_filter` plus `flow_direction` for a bounded event,
  worker, queue, cron, CLI, or data-flow view; keep a broad natural-language result as orientation
  evidence.
- **Inspect one exact symbol deeply**: `context_bundle` for the bounded edit workset;
  `inspect_symbol` for the raw point query and on-demand JS/TS reference evidence.
- **Confirm graph evidence in source**: `read_source`; use `search_code` only for a narrow regex/glob
  check. Search is supporting evidence, not the repository-intelligence layer.

### Runtime, API and change scenarios

- **Inventory HTTP routes**: `list_endpoints` for declared/reachable composed paths and mount proof.
- **Trace one endpoint through the application**: `trace_endpoint` for route -> handler -> bounded
  downstream call flow with edge-centered excerpts.
- **Trace an API contract across repositories**: `list_known_repos` -> `trace_api_contract` with an
  explicit backend/client set; prefer this over separate per-repository endpoint/search passes when
  a backend change may affect registered clients, and inspect each graph reconciliation state before
  using the verdict.
- **Measure one symbol's transitive blast radius**: `get_dependents`.
- **Review the current branch, diff, or external patch**: `change_impact`; its explicit baseline
  parameter is `base`, not the `base_ref` used by audit/diff/verification tools. It distinguishes
  additive exports from signature/body/removal risk and separates runtime/type-only radius plus
  available measured coverage or explicitly static reachability.
- **Compare structural graph revisions**: `graph_diff base_ref=<merge-base>` for module edges, cycles,
  orphans and lost callers; without `base_ref`, compare the last rebuild snapshots.
- **Use behavioral history**: `git_history` for churn x connectivity, hidden co-change and expected
  test/source coupling from bounded local Git numstat evidence.
- **Plan and verify a serious change or pre-commit gate**:
  `verified_change task=<same-task> phase=plan base_ref=<merge-base>` -> edit ->
  `verified_change task=<same-task> phase=verify base_ref=<same-ref>`. It composes exact context, impact, graph,
  architecture, duplicate, optional API and test proof into one PASS/BLOCKED/UNKNOWN envelope. It is
  a proof layer around an agent's edit, not a source editor or hidden auto-fix.

### Health, debt and testing scenarios

- **Run a whole-repository Health review**: `run_audit debt=all`, then read its capability matrix.
  `STRUCTURE CHECKED` and `DEPENDENCIES CHECKED` do not imply runtime or concurrency correctness.
- **Gate only newly introduced branch debt**: `run_audit base_ref=<merge-base> debt=new`; old debt in
  a changed file remains existing.
- **Review dependency declarations/imports**: `run_audit category=dependencies`; it includes missing,
  unused, duplicate, unresolved-import and lockfile-drift evidence without relabelling identities.
  Maven/Gradle manifests are inventoried but unsupported import-to-artifact verification is reported
  `NOT_SUPPORTED`/`PARTIAL`, never a false clean `0 declared / 0 external`.
- **Refresh vulnerability evidence when explicitly authorized**: `refresh_advisories`, then
  `run_audit category=vulnerability`. `NOT_CHECKED` is unknown, never clean.
- **Review dead files, functions, methods and symbols**: `find_dead_code`; every result remains a
  review candidate with framework/dynamic/public-API caveats, never an auto-delete verdict.
- **Review clone families or same-name divergence**: `find_duplicates`; framework router boilerplate
  is suppressed unless explicitly requested.
- **Map measured coverage or honest static test reachability**: `coverage_map`; unavailable measured
  coverage is not 0%.
- **Prioritize local performance-review candidates**: `hot_path_review`; confirm with a profiler or
  benchmark before changing runtime behavior.

### Intended architecture and Hosted governance

- **Read or establish intended architecture**: `get_architecture_contract`. A returned starter adapts
  to Maven/Gradle source roots and monorepos and proposes product-code territories plus observed
  dependency directions labelled `OBSERVED_NOT_ENFORCED`; oversized Java branches split only at real
  child packages. Only runtime-cycle and 300-line file guards are active by default; generic
  complexity/cohesion thresholds are `CANDIDATE_NOT_ENFORCED`. None becomes policy automatically.
- **Bootstrap local policy safely**: `get_architecture_contract action=preview` with an optional
  reviewed `candidate_contract` and `baseline_mode=none|accept-current`; inspect the exact content,
  verification and patch, then call `action=approve confirm_token=<exact-token>`. Approval creates
  only a missing `.weavatrix/architecture.json`, rechecks graph identity, and never overwrites policy.
- **Select rules before editing**: `prepare_change`; **enforce the ratchet after editing**:
  `verify_architecture`.
- **Understand or request an exception**: `explain_architecture_violation` ->
  `propose_architecture_exception`; proposals never mutate policy automatically. After human approval,
  the owner must add the returned proposal to the local contract's `exceptions` or approve it in Hosted.
- **Pull an owner-approved Hosted target**: `pull_architecture_contract` only in an explicitly enabled
  Hosted profile.
- **Review exactly what Hosted sync would send**: `preview_sync`; only an approved
  `sync_graph dry_run=false confirm_token=...` may send that exact bounded payload.

Across every scenario, treat `PARTIAL`, `UNAVAILABLE`, `OFF`, `NOT_SUPPORTED`, `NOT_CHECKED`,
`ERROR`, or capped evidence as incomplete rather than success. Java and Rust exact language-server
providers are not bundled, so their edges never become `EXACT_LSP` even when a mixed repository has
a complete TypeScript/JavaScript overlay. Java and Go receiver-type call edges are parser-resolved
and explicitly `INFERRED`; Go resolution uses parameter, local, constructor-return, imported and
struct-field types. These edges improve cross-file flow without claiming compiler-exact overload,
interface dispatch, reflection, or runtime behavior.

## Ground rules

- **No hidden source mutation**: Weavatrix builds derived graph/cache artifacts and can run explicitly
  authorized tests, but it does not edit repository source, auto-delete debt, merge clones, or rewrite
  architecture policy. The coding agent remains responsible for the change and its tests.
- **Evidence, not verdicts**: treat audit, hub, orphan and duplicate output as hypotheses. Confirm a
  finding in source and check framework/runtime conventions before deleting, merging or redesigning
  code. A same-name/different-body pair is a divergence candidate, not proof of duplication.
- **Freshness**: graph/health calls automatically reconcile the active graph, while cross-repository
  tracing reconciles every selected registered graph. Read the structured `refresh` /
  `graphReconciliation` status: `none`, `incremental`, `full`, or explicitly `PARTIAL`. Use
  `rebuild_graph` only when automatic reconciliation reports a fallback/error or when intentionally
  changing build mode. A normal `open_repo` builds missing graphs and upgrades legacy schemas;
  `build:false` deliberately refuses that upgrade.
- **Ambiguity**: `get_node`/`get_neighbors`/`get_dependents` disclose `matched N nodes; using the
  best-connected` — read that note before trusting the answer; pass an exact node id to pin it.
- **Runtime versus compile time**: keep runtime cycles separate from TypeScript type-only and
  language compile-only coupling (Rust `mod`/`use`/`pub use`, Java imports). `module_map`,
  `change_impact` and `graph_diff` label the distinction; `god_nodes` ranks unique connectivity and
  reports repeated references separately. Do not schedule a runtime-cycle refactor from
  compile-time-only edges.
- **Edge provenance**: distinguish how an edge was established from legacy confidence. The parser
  emits `EXTRACTED`, `RESOLVED`, and `INFERRED`; the bundled bounded TypeScript/JavaScript language
  server emits `EXACT_LSP` only for references it confirms. `CONFLICT` means evidence disagrees.
  Treat `INFERRED`, `CONFLICT`, `PARTIAL`, `UNAVAILABLE`, and `OFF` as review signals rather than
  compiler-exact facts; an `UNKNOWN` count or revision-mismatched overlay in `graph_stats` requires
  a rebuild before precision-sensitive work.
- **Repository universe**: in Git repositories, graph and duplicate scans include tracked plus
  non-ignored untracked files. If an old graph still contains packaged/generated output, rebuild it
  before interpreting the result. Repository-root `.weavatrixignore` applies the same tracked-file
  exclusions to graph, audit and duplicate passes; use it for generated/e2e fixtures that must stay
  committed. `no-tests` also recognizes Cypress, Playwright, `test-e2e`, acceptance and integration
  roots. Dead-code/clone/audit review also suppresses `benchmarks/**` and `**/__temp/**` as classified
  non-production surfaces. A verified production benchmark can opt back in narrowly through
  `.weavatrix.json` `classify.product`, for example `{"classify":{"product":["benchmarks/core/**"]}}`.
- **Architectural queries**: broad bootstrap/tool-execution/routing questions rank conventional
  production and graph-declared entry points ahead of classified docs, sites, benchmarks and
  fixtures. Production-first classification also applies during traversal. A class term in the
  question enables only that class; `include_classified=true` enables all classified paths. Exact
  non-product `seed_files` remain pinned. Unmatched unreferenced constant/field leaves are suppressed
  unless `include_low_signal=true`. Inspect the returned seeds/policy before trusting the traversal.
- **Coverage**: `coverage_map` reads an existing report. `unavailable` means no supported report was
  found, not 0% coverage; do not rank testing risk from that state.
- **Local hot paths**: `hot_path_review` ranks parser-derived local syntax cost and reports graph
  fan-in/fan-out plus test evidence separately. `actualCoverage: NOT_AVAILABLE` is not zero coverage,
  and the score is not profiler data or an interprocedural Big-O proof. The default queue uses
  `min_score=85` plus a narrow strong-local fallback; use `min_score=0` only for full diagnostics.
  Inspect its line evidence and measure runtime before scheduling a performance rewrite.
- **Audit completeness**: read the top-level Health capability matrix first: structure, dependencies,
  runtime correctness, concurrency, advisories, malware and measured coverage each have independent
  status/completeness. The bounded Go/Java correctness patterns can flag a fixed-index slice hazard,
  discriminator mismatch, lost Java interrupt or unbounded retry candidate, but they are not a
  compiler, race detector, runtime trace, CFG, or proof of race freedom. Then read
  `dependencyReport.status`, ecosystem support, unused/missing counts, each npm finding's
  `verification` (manifest, indexed source, scripts/config, unresolved dynamic usage), and
  `checks.osv.status` / `checks.malware.status`. A dependency result from a partial or unsupported
  ecosystem is not a repository-wide clean zero. For OSV, `OK` is
  complete for the recorded dependency fingerprint; `PARTIAL` is incomplete or stale,
  `NOT_CHECKED` has no repository-specific result, and `ERROR` means the local check failed. Treat
  the same non-`OK` states as incomplete for malware scanning. Refresh OSV only when the user has
  authorized selecting the optional `osv` profile (or `advisories` capability) and then
  invoking `refresh_advisories`; enabling the group alone sends nothing.
- **Offline by design**: scans and graph queries use local files; the semantic overlay may launch
  Weavatrix's bundled read-only TypeScript language-server child process, but it never runs repository
  scripts or downloads a provider. Coverage tools read existing reports and never run tests. The
  ONLY network-touching tools live in the optional
  `advisories` / `hosted` capabilities and run solely when explicitly called:
  `refresh_advisories` (queries OSV.dev with
  package names + versions so `run_audit` has fresh vulnerability data) and `sync_graph` (pushes only
  the exact allowlisted graph/evidence contract previously serialized by local-only `preview_sync` to a
  user-configured endpoint; analyzers may read local source, but the wire contract has no body,
  snippet, absolute-host-path or environment fields, and unknown fields are discarded; disabled until
  `WEAVATRIX_SYNC_URL` is set). `pull_architecture_contract` sends only the active repository's opaque
  stable UUID, downloads the owner-approved contract, validates it, and caches it locally; it requires
  `WEAVATRIX_SYNC_URL` and `WEAVATRIX_SYNC_TOKEN`. All three are absent from the default profile.
- **Repository boundary**: source reads and graph-derived paths are realpath-contained. `open_repo`
  intentionally changes the active boundary through an explicit offline tool call. It is included in
  `offline`, absent from `pinned`, and available in a custom registration only when `retarget` is
  named. Concurrent non-mutating calls retain the graph/root snapshot with which they started.

- **Test execution is separately authorized**: `verified_change` only executes named
  `package.json` test/check/verify scripts when the call has `run_tests:true` and the server was
  started with `WEAVATRIX_ALLOW_TEST_RUNS=1`. It never accepts arbitrary shell commands. Without
  both gates it returns a plan or `UNKNOWN` evidence state.

## Recipes

- **Proof-carrying refactor**: `verified_change task=<same-task> phase=plan base_ref=<merge-base>` -> edit ->
  `verified_change task=<same-task> phase=verify base_ref=<same-ref> tests=[{"script":"test","args":[...]}]`.
  Repeat `task` on both calls; it is required and is not retained between invocations.
  Add `run_tests:true` only when test execution was authorized. `BLOCKED` means an evidenced ratchet
  or test failure; `UNKNOWN` means at least one required proof is incomplete.

- **Orient in the configured repo**: `module_map` → `list_communities` → `god_nodes`. Hub ranking
  is production-only by default; use `include_classified:true` only when tests/generated/build
  surfaces are deliberately part of the question.
- **Refactor safety for one symbol**: `context_bundle` → optional `inspect_symbol` when raw LSP
  occurrences, ambiguity details or the larger source window are needed → `get_dependents` →
  `coverage_map` (low coverage × many dependents ⇒ write tests first) → edit →
  `verified_change task=<task> phase=verify base_ref=<merge-base>`.
- **Performance review**: `hot_path_review` → inspect its local evidence with `read_source` → use
  `get_dependents` for change risk → confirm with the repository's profiler/benchmark before editing.
- **Pre-PR review of your current changes**: `change_impact` (auto merge-base; includes uncommitted
  and untracked work, coverage attached, untested hotspots called out) → drill with `get_dependents`.
- **Impact of a PR that is NOT checked out**: pass its changed-file list explicitly —
  `change_impact files=[…]` — same blast-radius + coverage view, no checkout.
- **Validate a refactor structurally**: call `graph_diff base_ref=HEAD~1` (or `main` / `origin/main`)
  to build an immutable baseline without checkout and compare it with the current graph. Alternatively,
  edit → `rebuild_graph`, then use `graph_diff` without `base_ref` to compare `graph.prev.json` with
  the rebuilt graph. Either route can be scoped by `path`; look for cycle, module-dependency and
  orphan drift rather than raw edge counts.
- **Health sweep**: for a branch/PR review prefer
  `run_audit base_ref=<merge-base> debt=new changed_files=[…]`; for repository maintenance use
  `run_audit debt=all`. Then call `find_dead_code`, `find_duplicates`, `coverage_map` and
  `hot_path_review`. A changed-file-only audit is
  scope, not proof of new debt. Inspect the source behind shortlisted findings before proposing edits.
- **Dead-code and dead-method review**: call `find_dead_code` for a bounded production-code queue of
  files, functions, methods and symbols. Narrow with `path` or `kinds=["method"]`; keep the default
  `min_confidence=medium` for actionable internal candidates. Use `min_confidence=low` only when the
  task explicitly needs public/exported, framework, dynamic-loading or reflection-sensitive review,
  and carry each returned caveat into the recommendation. Pair it with
  `run_audit category=unused debt=all` (or `base_ref=<merge-base> debt=new`) for unused exports and
  dependencies. Before deletion, run `read_source`, `get_dependents`, exact `search_code`, inspect
  framework discovery/annotations, package scripts, CLI/Docker/manifests, generated consumers and
  test-only use, then run the repository tests. Use `evidenceTier` and `remainingChecks` to order the
  review; even `STRONG_STATIC_EVIDENCE` is exact zero-reference evidence, not deletion permission.
  `REVIEW_REQUIRED` and `autoDelete:false` are hard
  safety semantics, not boilerplate. Use `.weavatrix-deps.json` entrypoints/nonRuntimeRoots only for
  verified conventions.
- **API inventory**: `list_endpoints` (including mount provenance, Next.js App Router, Rust axum and
  actix-web). Spring endpoint rows also expose conditional activation and whether the controller is
  inactive by default. When one exact route is known, use `trace_endpoint` for its composed mount
  chain, handler and bounded production call graph instead of broad natural-language traversal.
- **CLI, worker, queue, cron or event flow**: identify the exact listener/handler/registration symbol,
  then call `query_graph seed_symbols=[...] relation_filter=["calls","references"]
  flow_direction="both"`; use `context_bundle` for production-first inbound/outbound containers and
  diverse call-site excerpts, then `get_dependents` / `read_source` for decisive evidence. If the
  symbol is unknown, use a narrow `search_code` registration check once and pin what it finds. Do not
  force a non-HTTP flow through endpoint tools or begin with an unconstrained natural-language seed.
- **Cross-repository API impact**: ensure both repositories are in `list_known_repos`, then call
  `trace_api_contract backend=<uuid-or-label> clients=[<uuid-or-label>]`; narrow with `method`, `path`,
  or backend `changed_files`. `path` may be a segment-aligned fragment (`/query` can select
  `/edgeAnalytics/query/...`), and bounded constant prefixes in template URLs are resolved. The tool
  recognizes configured and conservatively auto-discovered HTTP wrappers; use per-repository
  `.weavatrix.json` `httpContracts` configuration for durable custom client names/wrappers, or
  `client_names` / `client_wrappers` for one trace. `NOT_DEAD_EXTERNAL_USE` requires medium/high
  confidence; only an unambiguously resolved handler node can suppress a dead-method candidate.
  `POSSIBLE_EXTERNAL_USE`, `UNKNOWN`, and remaining unresolved/dynamic URLs are incomplete evidence,
  never proof that a method is dead.
- **Release regression gate**: for a Weavatrix source checkout, use `npm test` for the full
  unit/integration suite, `npm run benchmark:quick` for the quick six-language golden corpus, and
  `npm run benchmark` before release for the golden corpus plus the real MCP
  `full -> incremental -> none -> reconnect/none` lifecycle, bounded output and active-target checks.
  Use `npm run benchmark:real` for available manifest repositories and
  `npm run benchmark:real:release` only when all six source checkouts are present; `MISSING`,
  `UNBASELINED` and `STALE` are explicit incomplete states, not green results.
  A green Java/Rust fixture proves only its declared representative signals, not compiler-exact
  coverage of arbitrary repositories.
- **Target architecture before editing**: if no contract exists, call
  `get_architecture_contract action=preview baseline_mode=none` and inspect the adaptive product
  territories, observed-but-not-enforced directions and verification. Pass a reviewed
  `candidate_contract` when the desired target differs. Only after explicit owner approval call
  `get_architecture_contract action=approve confirm_token=<exact-token>`. Use
  `baseline_mode=accept-current` only when the owner intentionally accepts current deterministic
  debt into the ratchet. Then run `prepare_change` with intended files → edit/rebuild →
  `verify_architecture`. An approved exception is still applied by adding the exact returned proposal
  to `exceptions` and verifying again. Existing contracts are never overwritten; Hosted contracts
  are pulled only after explicit opt-in. No tool silently changes an active policy.
- **Behavioral architecture**: `git_history` ranks churn × connectivity hotspots and hidden
  co-change coupling from bounded local numstat history. Always set `top_n`; it is enforced across
  every returned structured collection and JSON reports per-collection truncation. Use it as review
  evidence, not proof that two files must be merged.
- **Machine output**: keep the default `output_format:"text"` for concise agent conversations; opt
  into `output_format:"json"` only when a workflow consumes the full `weavatrix.tool.v1` envelope.
- **Find code**: `search_code` (regex + glob) →
  `read_source path=<match-path> start_line=<match-line>`; add `get_node` / `get_neighbors` only after
  identifying an exact graph symbol.
- **Another repo**: `list_known_repos` → `open_repo <path>`
  (builds or upgrades the graph when needed; `build:false` probes without building).

## Repository-specific conventions

Weavatrix understands nearest workspace manifests, nested `tsconfig`/`jsconfig` aliases,
framework-owned runtime peers such as Next.js + `react-dom`, generated NAPI-RS platform loaders,
and Next.js App Router route exports. Use repository-root `.weavatrix.json` to correct ambiguous
production classification without deleting graph evidence:

```json
{
  "classify": {
    "generated": ["src/generated/**"],
    "test": ["qa/**"],
    "product": ["benchmarks/core/**"]
  },
  "exclude": ["resources/snapshots/**"]
}
```

Use `generated` / `test` (or `e2e`, `mock`, `story`, `docs`, `benchmark`, `temp`) for non-production
code, top-level `exclude` for resource/catalog roots that should stay visible in the graph but not
drive production-first Health/query ranking, and `product` only to opt a verified benchmark/temp path
back into production review. `product` does not override an explicit generated/test classification or
`exclude`. Use `.weavatrixignore` instead only when a path must be removed consistently from graph,
audit and duplicate scans.

For project-specific entry points, reusable template catalogs, or Python dependencies supplied by an
external runtime, add `.weavatrix-deps.json` at the repository root:

```json
{
  "entrypoints": ["scripts/publish-release.mjs"],
  "nonRuntimeRoots": ["library", "catalogs/examples"],
  "python": {
    "managedDependencies": ["numpy", "openvino-genai"],
    "ignoreDependencies": ["vendor-sdk"]
  }
}
```

Keep exceptions narrow. `nonRuntimeRoots` (alias `templateRoots`) marks reusable examples that are
not one deployed application. It suppresses orphan/dead/unused-export noise and missing/unresolved
dependency findings when every use is inside those roots; graph edges, cycles and boundaries remain
visible. `managedDependencies` documents modules provided outside the repo's Python manifest;
`ignoreDependencies` suppresses intentionally unresolved imports.

## Sync

Call `preview_sync` first. It validates the configured destination and serializes payload v3 locally,
returning the repository UUID, exact fields/sections, counts, bytes, hash and short-lived confirmation
token without networking. After explicit approval, call `sync_graph dry_run=false` with that token.
Payload v3 contains graph metadata plus deterministic architecture, health, stack,
package-dependency and clone-review evidence. Read each section's `state`, `verdict` and completeness counts; `PARTIAL`,
`NOT_CHECKED` and `ERROR` are unknown/incomplete, never a clean result. Architecture evidence
contains concrete runtime versus compile-time cycles, declared boundary violations and separated
runtime/type-only/compile-only module dependencies. Package evidence contains a bounded lockfile
graph with direct/transitive runtime, dev, optional and peer edges plus explicit resolution counts.
Duplicate evidence contains stable, source-free clone/divergence candidates; it never sends method
bodies or snippets. Use `payload_version: 2` only when the user explicitly wants graph-only
compatibility—Weavatrix never silently downgrades. A graph predating current provenance metadata, or one stale against
the working tree, must be rebuilt first. Sync remains unavailable until the user selects `hosted`
(or the exact `hosted` capability) and configures `WEAVATRIX_SYNC_URL`.

## Troubleshooting

- `Graph unavailable` → `rebuild_graph`; normal graph/health calls automatically refresh an existing
  graph and report `none`, `incremental`, or `full`. `open_repo` can select another valid repository path unless
  the registration deliberately omitted `retarget`.
- `refresh_advisories` is unavailable → with the user's approval, re-register/reconfigure the MCP
  with the `osv` profile, reconnect it, and then invoke the tool. Do not enable network
  access merely to turn `NOT_CHECKED` into a cosmetic green state.
- `preview_sync` / `pull_architecture_contract` / `sync_graph` is unavailable → use the `hosted` profile only after
  the user chooses hosted integration; configure `WEAVATRIX_SYNC_URL` and a bearer token for contract
  pull. Profile selection alone never performs a request.
- `No coverage report` → run the repo's own tests with coverage (`vitest run --coverage`,
  `jest --coverage`, `pytest --cov --cov-report=json`, `go test -coverprofile=coverage.out`),
  then re-call.
- `change_impact` says files are "not in the graph" → they're new/renamed; `rebuild_graph` and retry.
