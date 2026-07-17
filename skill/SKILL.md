---
name: weavatrix
description: Drive the weavatrix MCP — code graph, blast-radius (get_dependents/change_impact), dead-code review, health audit, duplicates, coverage, endpoints — over any local repo. Use when analyzing code structure, refactor risk, dead code, dependency health, or before opening a PR.
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

If `refresh_advisories`, `pull_architecture_contract`, or `sync_graph` is missing, do not diagnose a
broken installation: network tools are intentionally absent from `offline` and `pinned`.

Profiles use the same npm package and binary:

- `offline` (default): all local analysis and explicit `open_repo`; no HTTP tools.
- `pinned`: local analysis with no `open_repo`, no global/cross-repository graph access, and no HTTP tools.
- `osv`: `offline` plus explicit `refresh_advisories`.
- `hosted` / `full`: `osv` plus `pull_architecture_contract` and `sync_graph`.

The legacy `online` capability remains a compatibility alias for `advisories,hosted`; prefer the
named profiles for new registrations.

## Ground rules

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
- **Edge provenance**: distinguish how an edge was established from legacy confidence. Current
  graphs use `EXTRACTED`, `RESOLVED`, and `INFERRED`; `EXACT_LSP` is reserved for a bounded local
  precision overlay and `CONFLICT` means evidence disagrees. Treat `INFERRED` and `CONFLICT` as
  review signals rather than compiler-exact facts; an `UNKNOWN` count in `graph_stats` requires a
  rebuild before precision-sensitive work.
- **Repository universe**: in Git repositories, graph and duplicate scans include tracked plus
  non-ignored untracked files. If an old graph still contains packaged/generated output, rebuild it
  before interpreting the result. Repository-root `.weavatrixignore` applies the same tracked-file
  exclusions to graph, audit and duplicate passes; use it for generated/e2e fixtures that must stay
  committed. `no-tests` also recognizes Cypress, Playwright, `test-e2e`, acceptance and integration
  roots. Dead-code/clone/audit review also suppresses `benchmarks/**` and `**/__temp/**` as classified
  non-production surfaces. A verified production benchmark can opt back in narrowly through
  `.weavatrix.json` `classify.product`, for example `{"classify":{"product":["benchmarks/core/**"]}}`.
- **Architectural queries**: for bootstrap/routing/authentication questions, inspect the returned
  seeds before trusting the traversal. Pass exact repository-relative `seed_files` to `query_graph`
  when the intended entry points are already known.
- **Coverage**: `coverage_map` reads an existing report. `unavailable` means no supported report was
  found, not 0% coverage; do not rank testing risk from that state.
- **Audit completeness**: read `checks.osv.status` and `checks.malware.status`. For OSV, `OK` is
  complete for the recorded dependency fingerprint; `PARTIAL` is incomplete or stale,
  `NOT_CHECKED` has no repository-specific result, and `ERROR` means the local check failed. Treat
  the same non-`OK` states as incomplete for malware scanning. Refresh OSV only when the user has
  authorized selecting the optional `osv` profile (or `advisories` capability) and then
  invoking `refresh_advisories`; enabling the group alone sends nothing.
- **Offline by design**: scans and graph queries run in-process against local files; coverage tools
  read existing reports and never run tests. The ONLY network-touching tools live in the optional
  `advisories` / `hosted` capabilities and run solely when explicitly called:
  `refresh_advisories` (queries OSV.dev with
  package names + versions so `run_audit` has fresh vulnerability data) and `sync_graph` (derives a
  bounded evidence snapshot locally, then pushes only an allowlisted graph/evidence contract to a
  user-configured endpoint; analyzers may read local source, but the wire contract has no body,
  snippet, absolute-host-path or environment fields, and unknown fields are discarded; disabled until
  `WEAVATRIX_SYNC_URL` is set). `pull_architecture_contract` sends only the active repository's opaque
  stable UUID, downloads the owner-approved contract, validates it, and caches it locally; it requires
  `WEAVATRIX_SYNC_URL` and `WEAVATRIX_SYNC_TOKEN`. All three are absent from the default profile.
- **Repository boundary**: source reads and graph-derived paths are realpath-contained. `open_repo`
  intentionally changes the active boundary through an explicit offline tool call. It is included in
  `offline`, absent from `pinned`, and available in a custom registration only when `retarget` is
  named. Concurrent non-mutating calls retain the graph/root snapshot with which they started.

## Recipes

- **Orient in the configured repo**: `module_map` → `list_communities` → `god_nodes`. Hub ranking
  is production-only by default; use `include_classified:true` only when tests/generated/build
  surfaces are deliberately part of the question.
- **Refactor safety for one symbol**: `get_dependents` → `coverage_map` (low coverage × many
  dependents ⇒ write tests first) → `read_source`.
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
  `run_audit debt=all`. Then call `find_dead_code`, `find_duplicates` and `coverage_map`. A changed-file-only audit is
  scope, not proof of new debt. Inspect the source behind shortlisted findings before proposing edits.
- **Dead-code and dead-method review**: call `find_dead_code` for a bounded production-code queue of
  files, functions, methods and symbols. Narrow with `path` or `kinds=["method"]`; keep the default
  `min_confidence=medium` for actionable internal candidates. Use `min_confidence=low` only when the
  task explicitly needs public/exported, framework, dynamic-loading or reflection-sensitive review,
  and carry each returned caveat into the recommendation. Pair it with
  `run_audit category=unused debt=all` (or `base_ref=<merge-base> debt=new`) for unused exports and
  dependencies. Before deletion, run `read_source`, `get_dependents`, exact `search_code`, inspect
  framework discovery/annotations, package scripts, CLI/Docker/manifests, generated consumers and
  test-only use, then run the repository tests. `REVIEW_REQUIRED` and `autoDelete:false` are hard
  safety semantics, not boilerplate. Use `.weavatrix-deps.json` entrypoints/nonRuntimeRoots only for
  verified conventions.
- **API inventory**: `list_endpoints` (including Next.js App Router, Rust axum and actix-web).
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
- **Release regression gate**: for a Weavatrix source checkout, use `npm test` for the quick
  six-language golden corpus and `npm run benchmark` before release for the real MCP
  `full -> incremental -> none -> reconnect/none` lifecycle, bounded output and active-target checks.
  Use `npm run benchmark:real` for available manifest repositories and
  `npm run benchmark:real:release` only when all six source checkouts are present; `MISSING`,
  `UNBASELINED` and `STALE` are explicit incomplete states, not green results.
  A green Java/Rust fixture proves only its declared representative signals, not compiler-exact
  coverage of arbitrary repositories.
- **Target architecture before editing**: `get_architecture_contract` → `prepare_change` with the
  intended files → edit and rebuild → `verify_architecture`. A missing contract returns a starter
  proposal from `get_architecture_contract output_format:"json"`, not an automatically approved
  architecture. Without a contract, `prepare_change` still returns provisional no-regression
  budgets, but they are guidance rather than enforceable policy. Pull an owner-approved hosted
  contract only when the user selected `hosted` and explicitly asks for it.
- **Behavioral architecture**: `git_history` ranks churn × connectivity hotspots and hidden
  co-change coupling from bounded local numstat history. Always set `top_n`; it is enforced across
  every returned structured collection and JSON reports per-collection truncation. Use it as review
  evidence, not proof that two files must be merged.
- **Machine output**: keep the default `output_format:"text"` for concise agent conversations; opt
  into `output_format:"json"` only when a workflow consumes the full `weavatrix.tool.v1` envelope.
- **Find code**: `search_code` (regex + glob) → `get_node` → `read_source`.
- **Another repo**: `list_known_repos` → `open_repo <path>`
  (builds or upgrades the graph when needed; `build:false` probes without building).

## Repository-specific conventions

Weavatrix understands nearest workspace manifests, nested `tsconfig`/`jsconfig` aliases,
framework-owned runtime peers such as Next.js + `react-dom`, generated NAPI-RS platform loaders,
and Next.js App Router route exports. For project-specific entry points, reusable template catalogs,
or Python dependencies supplied by an external runtime, add `.weavatrix-deps.json` at the repository
root:

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

`sync_graph` defaults to payload v3: graph metadata plus deterministic architecture, health, stack,
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
- `pull_architecture_contract` / `sync_graph` is unavailable → use the `hosted` profile only after
  the user chooses hosted integration; configure `WEAVATRIX_SYNC_URL` and a bearer token for contract
  pull. Profile selection alone never performs a request.
- `No coverage report` → run the repo's own tests with coverage (`vitest run --coverage`,
  `jest --coverage`, `pytest --cov --cov-report=json`, `go test -coverprofile=coverage.out`),
  then re-call.
- `change_impact` says files are "not in the graph" → they're new/renamed; `rebuild_graph` and retry.
