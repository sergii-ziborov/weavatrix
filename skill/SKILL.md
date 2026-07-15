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

## Ground rules

- **Freshness**: every graph tool appends a staleness warning when the repo has commits newer than
  the graph. Act on it: `rebuild_graph`.
- **Ambiguity**: `get_node`/`get_neighbors`/`get_dependents` disclose `matched N nodes; using the
  best-connected` — read that note before trusting the answer; pass an exact node id to pin it.
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
  `coverage_map`.
- **API inventory**: `list_endpoints`.
- **Find code**: `search_code` (regex + glob) → `get_node` → `read_source`.
- **Another repo**: `list_known_repos` → `open_repo <path>`
  (builds the graph when missing; `build:false` probes without building).

## Troubleshooting

- `Graph unavailable` → `rebuild_graph`; `open_repo` can select another valid repository path unless
  the registration deliberately omitted `retarget`.
- `No coverage report` → run the repo's own tests with coverage (`vitest run --coverage`,
  `jest --coverage`, `pytest --cov --cov-report=json`, `go test -coverprofile=coverage.out`),
  then re-call.
- `change_impact` says files are "not in the graph" → they're new/renamed; `rebuild_graph` and retry.
