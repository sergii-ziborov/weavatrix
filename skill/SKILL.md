---
name: weavatrix
description: Drive the weavatrix MCP — code graph, blast-radius (get_dependents/change_impact), health audit, duplicates, coverage, endpoints — over any local repo. Use when analyzing code structure, refactor risk, dead code, dependency health, or before opening a PR.
---

# weavatrix MCP

Structure-analysis tools over a prebuilt code graph plus the weavatrix analysis engines. The default
is offline and includes `open_repo` for one-call switching between local Git repositories. A custom
capability list that omits `retarget` pins the registration to its initial repository.

## Step 0 — if the tools are missing

Tools are named `mcp__weavatrix__…`. If none are available, ask the user to register the server
(`claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot>`; Codex:
`codex mcp add weavatrix -- npx -y weavatrix <repoRoot>`), then retry.

If only `refresh_advisories` or `sync_graph` is missing, do not diagnose a broken installation:
`online` is intentionally absent from the default capability list.

## Ground rules

- **Evidence, not verdicts**: treat audit, hub, orphan and duplicate output as hypotheses. Confirm a
  finding in source and check framework/runtime conventions before deleting, merging or redesigning
  code. A same-name/different-body pair is a divergence candidate, not proof of duplication.
- **Freshness**: every graph tool appends a staleness warning when the repo has commits newer than
  the graph. Act on it: `rebuild_graph`. A normal `open_repo` builds missing graphs and upgrades
  pre-`0.1.4` graphs to edge metadata v2; `build:false` deliberately refuses that upgrade.
- **Ambiguity**: `get_node`/`get_neighbors`/`get_dependents` disclose `matched N nodes; using the
  best-connected` — read that note before trusting the answer; pass an exact node id to pin it.
- **Runtime versus compile time**: keep runtime cycles separate from TypeScript type-only and
  language compile-only coupling (Rust `mod`/`use`/`pub use`, Java imports). `module_map`,
  `change_impact` and `graph_diff` label the distinction; `god_nodes` ranks unique connectivity and
  reports repeated references separately. Do not schedule a runtime-cycle refactor from
  compile-time-only edges.
- **Repository universe**: in Git repositories, graph and duplicate scans include tracked plus
  non-ignored untracked files. If an old graph still contains packaged/generated output, rebuild it
  before interpreting the result.
- **Coverage**: `coverage_map` reads an existing report. `unavailable` means no supported report was
  found, not 0% coverage; do not rank testing risk from that state.
- **Audit completeness**: read `checks.osv.status` and `checks.malware.status`. For OSV, `OK` is
  complete for the recorded dependency fingerprint; `PARTIAL` is incomplete or stale,
  `NOT_CHECKED` has no repository-specific result, and `ERROR` means the local check failed. Treat
  the same non-`OK` states as incomplete for malware scanning. Refresh OSV only when the user has
  authorized adding the optional `online` capability group to the MCP registration and then
  invoking `refresh_advisories`; enabling the group alone sends nothing.
- **Offline by design**: scans and graph queries run in-process against local files; coverage tools
  read existing reports and never run tests. The ONLY network-touching tools live in the `online`
  capability group and run solely when explicitly called: `refresh_advisories` (queries OSV.dev with
  package names + versions so `run_audit` has fresh vulnerability data) and `sync_graph` (pushes a
  versioned allowlist of graph metadata, discarding unknown fields and never reading source file
  bodies for sync, to a user-configured endpoint; disabled until
  `WEAVATRIX_SYNC_URL` is set). `online` is
  absent from the default capability set and must be enabled explicitly.
- **Repository boundary**: source reads and graph-derived paths are realpath-contained. `open_repo`
  intentionally changes the active boundary through an explicit offline tool call. It is available
  by default; omit `retarget` from a custom capability list to hide it.

## Recipes

- **Orient in the configured repo**: `module_map` → `list_communities` → `god_nodes`.
- **Refactor safety for one symbol**: `get_dependents` → `coverage_map` (low coverage × many
  dependents ⇒ write tests first) → `read_source`.
- **Pre-PR review of your current changes**: `change_impact` (auto merge-base; includes uncommitted
  and untracked work, coverage attached, untested hotspots called out) → drill with `get_dependents`.
- **Impact of a PR that is NOT checked out**: pass its changed-file list explicitly —
  `change_impact files=[…]` — same blast-radius + coverage view, no checkout.
- **Validate a refactor structurally**: edit → `rebuild_graph` — it reports the structural delta
  (cycle broken? new module dependency introduced? symbols orphaned?); re-query later with
  `graph_diff` (optionally scoped by `path`). The semantic complement to the textual git diff.
- **Health sweep**: `run_audit` (filter by `category`/`min_severity`) → `find_duplicates` →
  `coverage_map`. Inspect the source behind shortlisted findings before proposing edits.
- **API inventory**: `list_endpoints` (including Next.js App Router, Rust axum and actix-web).
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

`sync_graph` uses allowlisted payload v2, including type-only/compile-only edge metadata but no
source bodies. A graph built before `0.1.4` must be rebuilt first; normal `open_repo` does this
automatically. Sync remains
unavailable until the user opts into `online` and configures `WEAVATRIX_SYNC_URL`.

## Troubleshooting

- `Graph unavailable` → `rebuild_graph`; `open_repo` can select another valid repository path unless
  the registration deliberately omitted `retarget`.
- `refresh_advisories` is unavailable → with the user's approval, re-register/reconfigure the MCP
  capability list to include `online`, reconnect it, and then invoke the tool. Do not enable network
  access merely to turn `NOT_CHECKED` into a cosmetic green state.
- `No coverage report` → run the repo's own tests with coverage (`vitest run --coverage`,
  `jest --coverage`, `pytest --cov --cov-report=json`, `go test -coverprofile=coverage.out`),
  then re-call.
- `change_impact` says files are "not in the graph" → they're new/renamed; `rebuild_graph` and retry.
