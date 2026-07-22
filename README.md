# Weavatrix

**Local repository intelligence for AI coding agents — understand an application fast, then change it with evidence.**

Weavatrix builds a reusable living graph of any local repository — files, symbols, imports, calls,
inheritance, Health findings, clone families and Git-history coupling — and gives Claude Code, Codex
or any MCP client a bounded map for fast understanding and low repeated context. The same graph then
answers change impact, Health, dead-code review, duplicates, history and intended-architecture
questions. **34 network-free tools. No repository data leaves your machine.**

- Website: [weavatrix.com](https://weavatrix.com)
- Source: [github.com/sergii-ziborov/weavatrix](https://github.com/sergii-ziborov/weavatrix)
- npm: [`weavatrix`](https://www.npmjs.com/package/weavatrix) — `npx -y weavatrix <repoRoot>`

This package is the complete offline engine under the MIT license: it reads and analyzes your code,
initiates no outbound HTTP, and never edits your source. It is the read-only base of a layered stack —
add [`weavatrix-refactor`](https://github.com/sergii-ziborov/weavatrix-refactor) (Apache-2.0) to apply
hash-verified, reversible edits, or [`weavatrix-online`](https://github.com/sergii-ziborov/weavatrix-online)
for authorized Cloud or self-hosted sync. Each is an optional superset that depends on this core through
a supported extension API; the offline/online split is documented in
[docs/adr/0001-v0.3-offline-online-split.md](docs/adr/0001-v0.3-offline-online-split.md).

## Install

Requires Node ≥ 18.

```sh
# Claude Code
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot>

# Codex CLI
codex mcp add weavatrix -- npx -y weavatrix <repoRoot>
```

```toml
# or in ~/.codex/config.toml
[mcp_servers.weavatrix]
command = "npx"
args = ["-y", "weavatrix", "C:/path/to/repo"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Or run from a clone:

```sh
git clone https://github.com/sergii-ziborov/weavatrix
cd weavatrix && npm install
claude mcp add -s user weavatrix -- node <path-to>/weavatrix/bin/weavatrix-mcp.mjs <repoRoot>
```

`<repoRoot>` is the repository to start with. Graphs are derived data and never live in your repo:
they are stored in the per-user registry at `~/.weavatrix/graphs/<repository-storage-key>/graph.json`
(with a stable `.repository-id` beside them). No graph yet? Ask the agent to call `rebuild_graph`, or
just use a tool — graph and Health reads auto-reconcile the working graph before answering.

An agent skill with recipes ships in [skill/SKILL.md](skill/SKILL.md) — install it as
`~/.claude/skills/weavatrix/SKILL.md` (Claude Code) or `~/.codex/skills/weavatrix/SKILL.md` (Codex).

## Configure

**Security profile** — pass a profile as the final positional argument (omitted = `offline`):

| Profile | Local repository switching | Cross-repo graph reads | Network requests | Tools |
|---|---:|---:|---:|---:|
| `offline` (default) | Yes, only via `open_repo` | Yes, only via `trace_api_contract` | None | 34 |
| `pinned` | No | No | None | 31 |

```sh
# hard-pin one repository and expose no cross-repo tools:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> pinned
```

Advanced registrations may pass an exact comma-separated capability set instead:
`graph,search,source,health,build,retarget,crossrepo`. A custom list must include `crossrepo` to
expose `trace_api_contract`. Legacy `online`/`osv`/`hosted`/`full` names fail loudly and point to
`weavatrix-online`.

**Semantic precision** — a bounded, read-only TypeScript/JavaScript language-server overlay is on by
default for new graphs and upgrades confirmed references to `EXACT_LSP`. Turn it off for parser-only
operation with `WEAVATRIX_PRECISION=off` (env), `precision:"off"` on `rebuild_graph`/`open_repo`, or
the MCPB installer's precision choice. Java and Rust have no bundled language server; their edges stay
parser-derived.

The startup prewarm queries 32 ranked symbols (never more than 64) by default. For a deliberate
high-budget pass, set `WEAVATRIX_PRECISION_MAX_SYMBOLS` above 64 or `WEAVATRIX_PRECISION_PREWARM=full`
to cover every eligible target up to a 10,000-symbol ceiling; `WEAVATRIX_PRECISION_MAX_REFERENCES`,
`WEAVATRIX_PRECISION_MAX_LINKS` and `WEAVATRIX_PRECISION_TIMEOUT_MS` tune the budgets. Repositories
that exceed a hard ceiling stay honestly `PARTIAL`.

**Repository config files** (all optional, repository-root):

- `.weavatrixignore` — analysis-only exclusions that should stay tracked in Git (`*`, `**`, `?`,
  root-anchored `/patterns`, directory suffixes, ordered `!` re-includes).
- `.weavatrix.json` — cross-repository HTTP client/wrapper contracts (`httpContracts`) and
  `classify.product` overrides.
- `.weavatrix-deps.json` — `entrypoints`, `nonRuntimeRoots`, and Python `managedDependencies` /
  `ignoreDependencies` for conventions that cannot be inferred safely.

**Test execution** — `verified_change` is read-only by default. Running an existing package
test/check/verify script requires both `run_tests:true` and `WEAVATRIX_ALLOW_TEST_RUNS=1`; arbitrary
commands are always rejected.

After an upgrade, reconnect the MCP server or start a new agent task before checking the tool list —
many clients snapshot `tools/list` for the lifetime of a connection. `graph_stats` reports the running
version, enabled capabilities and registered-tool count so a cached process is distinguishable from
the installed package.

## Tools

The 34 methods project the same reusable graph into the smallest view a task needs.

- **graph** — `graph_stats`, `get_node`, `get_neighbors`, `query_graph`, `god_nodes`, `shortest_path`,
  `get_community`, `list_communities`, `module_map`, `get_dependents`, `change_impact`,
  `verified_change`, `git_history`, `graph_diff`, `get_architecture_contract`, `prepare_change`.
  Runtime, TypeScript type-only and language compile-only edges are reported separately; every edge
  carries versioned provenance (`EXTRACTED` / `RESOLVED` / `INFERRED`, upgraded to `EXACT_LSP` only by
  the bundled TS/JS overlay, `CONFLICT` when evidence disagrees).
- **search / source** — `search_code` (ripgrep-backed with a pure-Node fallback and
  repository-relative path globs), `read_source`, `context_bundle`, `inspect_symbol`,
  `list_endpoints` (Express/Fastify/Nest/Flask/FastAPI/Go mux/Rust axum & actix-web/Spring),
  `trace_endpoint`.
- **health** — `find_dead_code`, `run_audit` (capability matrix + unused files/exports/dependencies,
  missing/duplicate deps, offline OSV vulnerabilities, typosquats, lockfile drift; `base_ref` +
  `debt: new|existing|all` for review-scoped results), `find_duplicates` (MOSS winnowing, catches
  renamed clones), `coverage_map`, `hot_path_review`, `verify_architecture`,
  `explain_architecture_violation`, `propose_architecture_exception`.
- **build** — `rebuild_graph` (reports the structural delta, keeps the prior state as `graph.prev.json`).
- **retarget** *(in `offline`, absent from `pinned`)* — `open_repo`, `list_known_repos`.
- **crossrepo** *(in `offline`, absent from `pinned`)* — `trace_api_contract` (joins routes to client
  call-sites across registered local graphs; reads no source).

Every finding is review evidence, never an auto-delete verdict: `find_dead_code` /
`run_audit category=unused` always return `REVIEW_REQUIRED` with `autoDelete:false`. Typecheck, tests
and runtime checks remain the release authority.

## Always-fresh graph

There is no watcher daemon to run and no manual refresh step: every graph/health call reconciles the
graph before answering. A Git-token freshness probe (HEAD + dirty/untracked content, debounced 2 s)
decides whether anything changed; when it did, a bounded incremental refresh reparses only the changed
files plus their reverse importers (≤ 24 changed / ≤ 80 reparsed JS/TS files) and merges the scoped
result into the previous graph under a file lock. Config/lockfile edits, export-surface changes,
barrel files and non-JS/TS languages fall back to a full rebuild — correctness always wins over speed.
Each refreshed answer carries a structured `refresh` record (`none` / `incremental` / `full`, changed
file count), so an agent can tell exactly which repository state it is reasoning about. The same
guarantees hold across concurrent MCP clients sharing one canonical graph.

## Benchmarks

Two gates ship in the repository:

- `npm run benchmark` — a reproducible golden suite for TypeScript, JavaScript, Python, Go, Java and
  Rust, plus cross-repository HTTP matching, framework conventions and the MCP graph lifecycle.
- `npm run benchmark:real` — compares revision-pinned local snapshots against the checked-in 0.2.1
  relation baseline; it fails on unexplained signal loss (`MISSING`/`STALE`/`UNBASELINED` stay
  incomplete, not green).

Representative local regression run (Windows x64, Node 24.15.0):

| Gate | Result | Selected evidence |
|---|---:|---|
| Six language fixtures | 6/6 PASS | exact symbols/edges and complete edge provenance |
| Cross-repo fixture | PASS, ~432 ms cold | endpoint match, typed wrapper, external use |
| Lifecycle | PASS | `full → incremental → none → reconnect/none` |
| Total fixture cold build | ~1.31 s | all six language graphs |
| Real-repository baseline | 6/6 PASS | TS, JS, Python, Go, Java and Rust snapshots |

Real snapshots ranged from 473 nodes / 1,165 edges in 0.22 s (Go) to 8,192 nodes / 21,814 edges in
9.44 s (TypeScript). These are regression measurements on one machine, not competitor benchmarks. See
[benchmark/cases.mjs](benchmark/cases.mjs) and [docs/benchmarking.md](docs/benchmarking.md).

## Security model

Socket capability alerts describe the expected powers of a local code-analysis tool; they are not
vulnerability findings. Where each comes from and how it is bounded:

| Capability alert | Why it exists | Activation and boundary |
|---|---|---|
| Network access | None in the MIT core | `offline`/`pinned` expose only local tools; online integration is a separate package |
| Shell access | Local `git` (staleness/impact), `rg` (search), the bundled tsserver for JS/TS semantics, Windows child-tree termination, optional `verified_change` test scripts | The semantic provider never runs repository code; test execution needs `run_tests:true` + `WEAVATRIX_ALLOW_TEST_RUNS=1` and rejects arbitrary commands |
| Debug / dynamic loading | Cache-busted `import()` hot-reloads watched MCP tool modules; `createRequire` loads package metadata and parser deps | Loads files from the installed package only; no `eval` |
| Environment access | Reads local `WEAVATRIX_*` settings; children inherit a credential-stripped env | Connector secrets are removed; tsserver receives only allowlisted OS/temp/locale values |
| Filesystem access | Reads the active repository, graph, lockfiles and coverage; writes derived graphs and caches | Realpath containment blocks traversal and symlink escapes; `pinned` removes `open_repo` |
| URL strings | Advisory findings may contain fixed OSV documentation links | The core has no outbound request implementation |

`read_source` accepts repo-relative regular files only, caps a read at 2 MB, and refuses lexical or
realpath escapes. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Languages

JavaScript · TypeScript · TSX · Python · Go · Java · C# · Rust · Solidity · HTML · CSS — parsed with
[web-tree-sitter](https://github.com/tree-sitter/tree-sitter) WASM grammars; no Python install and no
native compilation.

SQL is indexed without a grammar: `.sql` files contribute tables, views, columns, functions, indexes
and triggers as first-class graph symbols, and SQL found in string literals of any other language
links the enclosing function to the table it queries. That makes schema objects visible to
`change_impact`/`get_dependents` (who touches this table?) and lets the dead-code check flag columns
no statement references — conservatively: verdicts require literal-SQL evidence in the repo, and
`SELECT *`-consumed tables never have their columns judged by name (ORM-generated SQL stays invisible
and is therefore never judged either).

Test surfaces are classified per file (path conventions plus `.weavatrix.json` overrides) and, for
Rust, per symbol: `#[cfg(test)]` modules and `#[test]`/`#[bench]` items inside production `.rs` files
carry a node-level `test_surface` flag, so dead-code, query, hot-path and hub tools treat them as
tests rather than production code.

## Development

```sh
npm install
npm test                 # unit/integration tests plus the quick golden benchmark
npm run benchmark        # full TS/JS/Python/Go/Java/Rust + MCP lifecycle gate
npm run benchmark:real   # locally available real repos vs source-free 0.2.1 baselines
```

Maintained JavaScript/TypeScript under `src`, `bin`, `scripts`, `test` has a hard 300-line physical
ceiling enforced by the release suite; larger concerns split into owner-focused modules behind slim
facades. The weavatrix.com landing site lives in its own repository (`weavatrix-site`).

## Release history

Per-version patch notes live in [docs/releases/](docs/releases/) — start with the newest entry there.
The release process and gates are in [scripts/verify-release.mjs](scripts/verify-release.mjs).

## License

The Weavatrix source in this repository is [MIT licensed](LICENSE) © 2026 Sergii Ziborov.
Third-party dependencies retain their own licenses. See the public
[license page](https://weavatrix.com/license) for the same notice.
