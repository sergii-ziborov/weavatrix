# Weavatrix

**Code graph & blast-radius MCP server for AI coding agents.**

Grep sees text. Weavatrix sees structure. It builds a dependency graph of any local repository —
files, symbols, and the imports/calls/inheritance connecting them — and serves it to Claude Code,
Codex, or any MCP client: change impact, transitive dependents, health audit, clone detection,
coverage mapping. **32 tools available; 29 enabled by the default offline profile. Local-first: with
the defaults, no repository data leaves your machine.**

- Website: [weavatrix.com](https://weavatrix.com)
- Source: [github.com/sergii-ziborov/weavatrix](https://github.com/sergii-ziborov/weavatrix)
- npm: [`weavatrix`](https://www.npmjs.com/package/weavatrix) — `npx -y weavatrix <repoRoot>`

## Why

An AI agent editing code without the dependency graph is refactoring blind. Weavatrix gives it
answers grep can't produce:

- *"What breaks if I change this?"* → `change_impact` diffs your branch (staged, unstaged and
  untracked included), maps the changed files and symbols onto the graph, and lists everything that
  depends on them — with test coverage attached, so the **untested part of the blast radius** stands
  out before you ship.
- *"Who calls this function?"* → `get_dependents` walks reverse edges transitively: every caller,
  importer and subclass that can feel the refactor, ranked by proximity × connectivity.
- *"Did my refactor actually decouple anything?"* → `graph_diff base_ref=HEAD~1` builds an immutable
  baseline graph without checking it out, then reports the structural delta: new module
  dependencies, broken or introduced import cycles, and symbols that lost their last caller.

## Quick start

Requires Node ≥ 18. One command:

```sh
# Claude Code — offline default; local repository switching is available explicitly:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot>
```

Codex CLI:

```sh
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

The package has one binary and several explicit security profiles. The omitted profile is `offline`:
all local analysis plus `open_repo`, with every HTTP tool absent. Pass one profile as the final
argument when a stricter repository boundary or a network feature is wanted:

| Profile | Local repository switching | Cross-repo graph reads | OSV requests | Hosted sync / contract pull |
|---|---:|---:|---:|---:|
| `offline` (default) | Yes, only through `open_repo` | Yes, only through `trace_api_contract` | No | No |
| `pinned` | No | No | No | No |
| `osv` | Yes | Yes, only when called | Only when `refresh_advisories` is called | No |
| `hosted` / `full` | Yes | Yes, only when called | Only when called | Only when `sync_graph` or `pull_architecture_contract` is called |

```sh
# Hard-pin one repository and expose no network tools:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> pinned

# Add only explicit OSV refresh:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> osv

# Enable the owner-authenticated hosted workflow:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> hosted
```

Advanced registrations may still pass an exact comma-separated capability set:
`graph,search,source,health,build,retarget,crossrepo,advisories,hosted`. The former `online` capability remains
a compatibility alias for `advisories,hosted`; new registrations should use the named profiles or
the narrower capability names.

Or clone it:

```sh
git clone https://github.com/sergii-ziborov/weavatrix
cd weavatrix && npm install
claude mcp add -s user weavatrix -- node <path-to>/weavatrix/bin/weavatrix-mcp.mjs <repoRoot>
```

- `<repoRoot>` — the repository to start with; the graph location is derived automatically in the
  per-user registry (`~/.weavatrix/graphs/<repository-storage-key>/graph.json`; its stable UUID is
  stored beside it in `.repository-id`). Pass an explicit
  `<graph.json> <repoRoot>` pair instead if you keep graphs elsewhere.

No graph yet? Ask the agent to call `rebuild_graph`; it builds the missing graph locally.
With the default `offline` profile (or an explicit capability set containing `retarget`),
`open_repo` can change the active repository
and builds a missing graph automatically. A normal
`open_repo` also upgrades graphs that predate current typed-edge/provenance metadata; `build:false`
probes without building and refuses a legacy graph. Retargeting is offline but intentionally changes
the filesystem boundary for subsequent tools; select `pinned` when that boundary must not move.

An agent skill with recipes ships in [skill/SKILL.md](skill/SKILL.md) — install as
`~/.claude/skills/weavatrix/SKILL.md`.

## Tools

**graph** — `graph_stats`, `get_node`, `get_neighbors`, `query_graph`, `god_nodes`,
`shortest_path`, `get_community`, `list_communities`, `module_map`, `get_dependents`,
`change_impact`, `git_history`, `graph_diff`, `get_architecture_contract`,
`prepare_change`. Runtime dependencies, TypeScript type-only coupling and language
compile-only edges (Rust module/use, Java imports) are reported separately where that distinction
changes the result.

Every current edge carries versioned provenance. The parser emits `EXTRACTED`, `RESOLVED`, and
`INFERRED`; the built-in bounded TypeScript/JavaScript precision overlay upgrades only references
confirmed by its bundled `typescript-language-server` + TypeScript runtime to `EXACT_LSP`.
`CONFLICT` means evidence disagrees. `graph_stats` reports the provenance breakdown and the semantic
provider's `COMPLETE`, `PARTIAL`, `UNAVAILABLE`, or `OFF` state; `OFF` means precision was explicitly
disabled and only static evidence is active. Java and Rust language-server providers are not bundled
in 0.2.4: their edges never become `EXACT_LSP`, even when a mixed repository reports a complete
TypeScript/JavaScript overlay.

The bounded JS/TS provider is enabled by default for new graphs. Set `WEAVATRIX_PRECISION=off`
before starting the MCP server for parser-only operation from the first build, or pass
`precision:"off"` to `rebuild_graph` / `open_repo`. The MCPB installer exposes the same `lsp` / `off`
choice as **TypeScript/JavaScript semantic precision**.

**search / source** — `search_code` (ripgrep-backed, pure-Node fallback), `read_source` (a
symbol's actual code in one hop), `list_endpoints` (HTTP route inventory:
Express/Fastify/Nest/Flask/FastAPI/Go mux/Rust axum and actix-web …)

**health** — `find_dead_code` (bounded review queue for statically unreferenced files, functions,
methods, and symbols, with confidence/evidence and explicit public/framework/dynamic caveats),
`run_audit` (unused files/exports/dependencies, missing npm/Go/Python deps, runtime
cycles, type-only/compile-only coupling, orphans, boundary rules, offline OSV vulnerabilities + typosquat +
lockfile drift; accepts an immutable `base_ref`, `changed_files`, and `debt: new|existing|all` for
review-scoped results), `find_duplicates` (MOSS winnowing over method bodies — catches copy-paste even
after renames), `coverage_map` (existing coverage reports mapped onto the graph; untested hotspots
ranked by connectivity — tests are never executed), `verify_architecture`,
`explain_architecture_violation`, `propose_architecture_exception`

**build** — `rebuild_graph` (reports the structural delta, keeps the prior state as
`graph.prev.json`)

For dead functions/methods/symbols, call `find_dead_code` first. Its default production-only queue
shows high/medium-confidence candidates and excludes tests, generated code, mocks, stories and docs;
use `kinds:["method"]` or a `path` prefix to narrow it. `min_confidence:"low"` explicitly includes
public APIs and framework/dynamic/reflection-sensitive candidates with their warnings. For repository
maintenance or branch debt, pair it with `run_audit category=unused debt=all` (or add an immutable
`base_ref` with `debt=new`) to cover unused files, exports and dependencies. Neither tool authorizes
deletion: inspect `read_source`, `get_dependents`, exact search, manifests/configuration and tests first.

`graph_diff` accepts `base_ref` (`HEAD~1`, `main`, `origin/main`, or another local Git ref) for a
fresh baseline comparison. Without it, the tool compares against `graph.prev.json` saved by the last
full rebuild. Either mode can be narrowed with `path`.

Graph and health calls reconcile the working graph before answering. Safe JS/TS body-only changes
reparse only the changed files plus bounded reverse importers; add/delete, export-surface, barrel,
manifest, alias, ignore/config, non-JS/TS, or unsafe merge cases deliberately fall back to a full
rebuild. The result says whether freshness was `none`, `incremental`, or `full`. Graph artifacts stay
in the per-user cache and never need to be committed to Git.

**retarget** *(included in `offline`; absent from `pinned`; every switch is an explicit local call)* —
`open_repo`, `list_known_repos`; changes the active repository boundary

**crossrepo** *(included in `offline`; absent from `pinned`; reads only registered local graphs)* —
`trace_api_contract`; reconciles the selected backend/client graphs and joins routes to client callsites

`query_graph` accepts optional `seed_files` when an architectural question must start from exact
entry points. Resolved explicit seeds are exclusive by default; set `augment_seeds:true` only when
question-derived seeds are also wanted. Broad bootstrap/tool-execution/routing questions now rank
conventional executables and graph-declared production entry points ahead of site, documentation, benchmark
and fixture matches. Broad ranking remains orientation evidence; use `seed_files` when the intended
entry point is already known.

**advisories** *(network, explicit opt-in)* — `refresh_advisories`

**hosted** *(network, explicit opt-in)* — `pull_architecture_contract`, `sync_graph`

Quality of life: graph/health reads auto-reconcile and expose `none` / `incremental` / `full`
freshness, with a short clean-read debounce to avoid rescanning the repository for every tool call;
ambiguous name lookups are
disclosed instead of silently guessed; and the server **hot-reloads its watched MCP tool entry
modules and catalog** when those files change — other MCP helpers and analysis engines require a
reconnect.

### 0.2.4 graph-mode correctness and semantic precision patch

- `graph_diff base_ref=...` builds the immutable baseline in the current graph mode, so a
  `no-tests` graph is never compared with a hidden `full` universe. Previous-rebuild snapshots with
  mismatched modes are rejected instead of reporting false removals or cycle drift.
- `trace_api_contract` preserves each registered repository's build mode during refresh and exposes
  that mode in `graphReconciliation`.
- `graph_stats` and `open_repo` expose the canonical graph path and build mode; an explicit mode
  mismatch with `build:false` fails closed instead of silently retargeting.
- `module_map` is production-only by default and can opt back into classified tests, fixtures,
  benchmarks, generated output and docs with `include_non_product:true`.
- A bundled, read-only TypeScript/JavaScript language server validates a bounded set of semantic
  references after graph reconciliation. Confirmed edges become `EXACT_LSP`; zero-reference evidence
  can strengthen an internal dead-code candidate only after a successful exact query. Partial,
  unavailable and revision-mismatched overlays stay visible and never become cosmetic exactness.
  The provider is Weavatrix's pinned `typescript-language-server` + TypeScript runtime, never a
  repository binary or `npx` download. Automatic type acquisition is disabled. Its child environment
  is reduced to OS/temp/locale basics with a Node/System path; registry, proxy, cloud, token and
  `NODE_OPTIONS` values are not inherited. TypeScript may still read locally declared project
  configuration, dependencies and type declarations; Weavatrix accepts returned evidence only after
  repository realpath containment. Applicable config chains are audited before provider startup;
  configured language-service plugins and unresolved/outside config are refused, while semantic
  inputs are fingerprinted before cache reuse and rechecked after each run. No source or evidence is
  transmitted, and the provider performs no Weavatrix HTTP request. MCP EOF/SIGTERM drains or
  tree-terminates TLS and tsserver before the stdio process exits.
- Broad `query_graph` bootstrap and tool-execution ranking now prefers production executables and
  graph-declared entry points over site, docs, benchmark and fixture surfaces. Exact `seed_files` remain
  the deterministic option when the caller already knows the entry point.
- The bundled skill routes orientation, diff review, cross-repository API tracing and exact-symbol
  work through Weavatrix's own evidence states. Java/Rust exact providers remain `UNAVAILABLE` in
  this release instead of being presented as compiler-confirmed.

Full patch notes: [docs/releases/v0.2.4.md](docs/releases/v0.2.4.md).

### 0.2.3 real-wrapper patch

- Auto-discovery recognizes wrappers that pass a fixed HTTP client method and argument array to a
  shared transport helper, such as `api(axios.get, [url, options])`.
- Ambiguous handler names can resolve to the unique matching symbol in a module directly imported
  by the route file, allowing proven external frontend calls to suppress only that exact backend
  dead-code candidate.
- Missing, ambiguous, low-confidence and capped evidence remains review-only; the patch does not
  turn absence of a client match into a dead-code verdict.

Full patch notes: [docs/releases/v0.2.3.md](docs/releases/v0.2.3.md).

### 0.2.2 regression and cross-repository evidence

- Permanent TS/JS/Python/Go/Java/Rust regression fixtures now gate graph correctness, output size,
  latency, freshness, reconnect behavior and repository-target stability.
- Every current graph edge carries versioned `EXTRACTED`, `RESOLVED`, or `INFERRED` provenance;
  `EXACT_LSP` and `CONFLICT` are reserved for the optional precision overlay.
- `trace_api_contract` recognizes configured and conservatively auto-discovered HTTP wrappers,
  resolves bounded dynamic URL prefixes and can mark an unambiguous backend handler
  `NOT_DEAD_EXTERNAL_USE` when another registered repository supplies medium/high-confidence use.
- Real-repository verification records explicit `MISSING`, `UNBASELINED`, and `STALE` gaps instead
  of converting absent Java/Rust or source-checkout evidence into a green result.
- No mandatory runtime dependency was added.

Full release notes: [docs/releases/v0.2.2.md](docs/releases/v0.2.2.md).

### 0.2.1 bounded-output patch

- `git_history top_n=N` is a hard per-collection MCP cap, including churn, hotspots and every
  coupling list. JSON output reports `total`, `returned` and `truncated` for each collection.
- `god_nodes` ranks production code by default, excluding classified tests and generated/build
  artifacts; pass `include_classified:true` only when those surfaces are intentionally in scope.
- `output_format:"text"` returns concise TextContent only. Use `output_format:"json"` when a
  workflow needs the full stable `weavatrix.tool.v1` structured envelope.
- `trace_api_contract` resolves bounded constant prefixes in template URLs and accepts
  segment-aligned path fragments such as `/query` for `/edgeAnalytics/query/...`.
- `change_impact` labels test/e2e edits as `test-only` and does not seed product blast radius from
  them.
- Without a saved architecture contract, `prepare_change` returns concise provisional budgets and
  clearly labels them as non-enforceable; request `get_architecture_contract output_format:"json"`
  only when the inferred starter contract is actually needed.

Full patch notes: [docs/releases/v0.2.1.md](docs/releases/v0.2.1.md).

## Signal quality and repository configuration

Weavatrix `0.2.0` reduces the most common sources of static-analysis noise while deepening Rust and
Java graphs:

- In Git repositories, graph and clone scans use tracked plus non-ignored untracked files, so
  `.gitignore`-excluded build outputs such as packaged applications do not dominate findings.
- Add a repository-root `.weavatrixignore` for analysis-only exclusions that should remain tracked
  in Git. It supports `*`, `**`, `?`, root-anchored `/patterns`, directory suffixes and ordered `!`
  re-includes. The same file universe is used by graph building, audits and clone scanning.
- `mode: "no-tests"` and `find_duplicates(include_tests:false)` classify `test-e2e`, Cypress,
  Playwright, acceptance and integration roots as tests, not only `*.test`/`*.spec` filenames.
- `benchmarks/**` and any `**/__temp/**` root are classified as non-production review surfaces and
  suppressed from dead-code/clone/audit queues by default. If a benchmark is deliberate production
  source, opt its narrow path back in with `.weavatrix.json` `classify.product` patterns.
- TypeScript `import type` and type-only re-exports remain visible as compile-time coupling but do
  not inflate runtime-cycle severity. `module_map`, `change_impact` and structural diffs preserve
  that distinction. `god_nodes` ranks unique neighbors with runtime connectivity first and reports
  repeated occurrences separately.
- Rust `mod`, `use` and `pub use` paths now resolve between files and modules. They are marked
  compile-only, so they enrich `module_map` and compile-time coupling without inventing runtime
  initialization cycles or promoting compile-time coupling to runtime impact. Axum and actix-web
  routes are included in `list_endpoints`.
- Java class/interface/enum/record/annotation declarations retain their symbol kind; methods and
  constructors are linked to their declaring type with visibility metadata. Internal
  `extends`/`implements` relationships and resolvable type references link to real declarations.
  Imports are compile-only; call/reference/heritage edges contribute impact. Maven/Gradle Java
  trees use package-aware communities instead of one giant `src` bucket. External or synthetic
  placeholder types are not created merely to inflate graph counts.
- Dependency checks resolve the nearest workspace manifest and `tsconfig`/`jsconfig` aliases,
  account for framework-owned runtime peers such as Next.js + `react-dom`, and recognize Next.js
  App Router route exports as endpoints.
- Generated NAPI-RS platform loaders and declared template/example catalogs no longer create
  phantom runtime dependency, orphan or unused-export findings. Conventional template roots are
  inferred conservatively; custom roots can be declared explicitly.
- `coverage_map` reports coverage as **unavailable** when no supported report exists. That means
  “no data”, not zero coverage.
- Duplicate output is a review queue, not a verdict: near-identical bodies are clone candidates;
  same-name/different-body pairs are divergence candidates. Read both sources and confirm the
  shared contract before consolidating code.
- `run_audit base_ref=... debt=new` compares stable finding fingerprints against a graph rebuilt
  from that immutable commit. Existing debt and fixed findings are counted separately. Supplying
  only `changed_files` is honestly labeled changed scope—it is never presented as proof that a
  finding is new.
- `find_dead_code` exposes the symbol-level liveness evidence already used by the audit as a bounded
  agent review queue. Public/exported methods, framework entries, decorators, dynamic loading and
  reflection lower confidence; the result always says `REVIEW_REQUIRED` and `autoDelete:false`.

### HTTP clients and wrappers

`trace_api_contract` recognizes built-in object clients such as `axios.get(...)`, explicit bare or
object/member wrappers, and simple auto-discovered functions that forward a URL parameter directly
to a known HTTP client. Auto-discovered wrappers are restricted to their bounded reverse-import
scope; ambiguous same-name definitions are skipped and reported as incomplete evidence.

Persistent per-client-repository configuration lives in `.weavatrix.json`:

```json
{
  "httpContracts": {
    "clientNames": ["internalHttp"],
    "wrappers": [
      { "call": "get", "method": "GET", "urlArgument": 0 },
      { "object": "transport", "member": "send", "method": "POST", "urlArgument": 1 }
    ],
    "autoDiscoverWrappers": true
  }
}
```

The MCP call exposes the same ad-hoc controls as `client_names`, `client_wrappers` and
`auto_discover_wrappers`. A medium/high-confidence client match marks the backend endpoint/handler
`NOT_DEAD_EXTERNAL_USE`; a low-confidence match is `POSSIBLE_EXTERNAL_USE`; no match is `UNKNOWN`.
Only an unambiguously resolved handler node can suppress a method-level dead-code candidate. The tool
never turns missing static evidence into a `DEAD` verdict.

`run_audit` makes incomplete security coverage explicit. OSV state is `OK` only after every
supported pinned package/version for this repository was queried successfully. `PARTIAL` means
some queries failed, the response was incomplete, the dependency fingerprint changed, or the cache
uses a legacy stamp; `NOT_CHECKED` means there is no per-repository refresh; `ERROR` means the local
check itself failed. None of the latter three states is a clean vulnerability result. The cache
stores a fingerprint of the supported dependency set so a lockfile change cannot silently reuse a
stale `OK`.

For conventions that cannot be inferred safely, add an optional `.weavatrix-deps.json` at the
repository root:

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

`entrypoints` protects framework/script entry files from dead-code classification.
`nonRuntimeRoots` (alias: `templateRoots`) marks reusable examples/templates that are not deployed
as one application. It suppresses orphan/dead/unused-export noise and missing/unresolved dependency
findings when every use is inside those roots. Import edges, cycles and boundary checks remain visible.
`managedDependencies` declares Python modules supplied by an external runtime;
`ignoreDependencies` suppresses intentionally unresolved Python packages. Keep the lists narrow:
they change audit interpretation, not the repository or its dependency installation.

## Privacy: local-first, offline by design

Graph queries, audits, clone scans and repository switching run locally. The default capability set
is `graph,search,source,health,build,retarget,crossrepo`: no Weavatrix HTTP requests. `open_repo`
changes the active local boundary only when called. Select `pinned` to remove repository switching,
global repository listing, and cross-repository graph tracing too.
Weavatrix itself initiates outbound HTTP only from three tools; all are absent from `offline` and
`pinned`, and none runs merely because a profile is enabled:

- `refresh_advisories` — queries [OSV.dev](https://osv.dev) with your lockfile's package
  **names + versions** (that is what an OSV query is; never source code) and caches the advisories
  in `~/.weavatrix/advisories.json`. `run_audit` then matches against that store fully offline.
- `pull_architecture_contract` — sends the active repository's opaque stable UUID with bearer
  authentication, downloads the owner-approved target-architecture contract, validates it, and
  stores the contract in the local graph cache. It sends no source, symbol, or repository path.
- `sync_graph` — builds a bounded evidence snapshot locally, then sends payload v3: the v2 graph
  allowlist plus module dependencies, runtime/compile-time cycles, declared boundary violations,
  health findings, complexity-threshold breaches, stack identifiers, a bounded direct/transitive
  dependency graph, direct package usage, and bounded clone/divergence review candidates. Local
  analyzers may read repository source and manifests to derive those
  facts. The wire contract has no fields for file bodies, snippets, absolute host paths, environment
  values or Git remotes; unknown fields are discarded and unsafe optional path metadata is omitted.
  The request also carries the normalized repository display name used by the
  hosted list. The endpoint is **yours**, configured through `WEAVATRIX_SYNC_URL` and the optional
  `WEAVATRIX_SYNC_TOKEN`; the feature is off by default. Pass `payload_version: 2` only for an
  intentional graph-only compatibility sync—there is no silent downgrade that discards evidence.
  Graphs that predate current typed-edge/provenance metadata must be rebuilt once before V3 sync;
  V3 also refuses a stale graph so
  source-derived evidence cannot be mixed with old topology.

Evidence sections carry independent `state` (`COMPLETE`, `PARTIAL`, `NOT_CHECKED`,
`NOT_APPLICABLE`, `ERROR`) and `verdict` (`PASS`, `FAIL`, `UNKNOWN`) fields plus exact
`total/returned/truncated` counts. An incomplete check is never converted into a clean zero. V3 is
deterministic: volatile timestamps are excluded and the allowlisted snapshot has a canonical SHA-256
fingerprint, so identical evidence does not manufacture a hosted revision. The client mirrors the
hosted 8 MiB / 25,000-node / 100,000-edge / 50,000-external-import safety limits before networking.

If a network tool is not listed by the MCP client, that is the expected offline default. With the
user's approval, select `osv` for advisory refresh only or `hosted` for the hosted workflow,
restart/reconnect the MCP server, and then invoke the intended tool. Enabling a profile does not
trigger a request by itself.

Profiles (`offline`, `pinned`, `osv`, `hosted`, `full`) or exact capability groups (`graph`,
`search`, `source`, `health`, `build`, `retarget`, `crossrepo`, `advisories`, `hosted`) are selectable through
the final positional argument. Omitted caps use `offline`; an explicit capability list exposes
exactly the named groups. Legacy `online` expands to `advisories,hosted` for compatibility.

## Security model

Socket capability alerts describe expected powers of a local code-analysis tool; they are not
vulnerability findings. This is where each capability comes from and how it is controlled:

| Capability alert | Why it exists | Activation and boundary |
|---|---|---|
| Network access | `refresh_advisories` sends pinned package names and versions to OSV; `pull_architecture_contract` sends an opaque repository UUID and receives an owner-approved contract; `sync_graph` sends a normalized repository label plus an allowlisted graph/evidence payload. Evidence is derived locally from source and manifests, but source bodies, snippets, absolute paths, environment values, credentials and Git remotes are excluded | `offline` and `pinned` expose no network tools. `osv` exposes only advisory refresh. `hosted`/`full` expose all three; every request still requires an explicit tool call, and hosted calls require `WEAVATRIX_SYNC_URL` |
| Shell access | Local `git` powers staleness/change impact; `rg` accelerates search; the bundled TLS/tsserver process supplies bounded JS/TS semantic evidence; timed-out Windows child trees may be terminated | Used only by the corresponding local operation. The semantic provider is package-pinned, disables automatic type acquisition, and never invokes a repository binary, script, installer or `npx` |
| Debug / dynamic loading | Cache-busted `import()` hot-reloads watched MCP tool entry modules; `createRequire` loads package metadata and parser dependencies | Loads files from the installed package; no `eval` |
| Environment access | Reads `WEAVATRIX_*` configuration; ordinary local helpers inherit a credential-stripped environment, while TLS/tsserver receives only allowlisted OS/temp/locale values and a constrained executable path | `WEAVATRIX_SYNC_TOKEN` is removed from every child-process and worker environment. TLS/tsserver also receives no registry/proxy/cloud credentials or `NODE_OPTIONS` |
| Filesystem access | Reads the active repository, graph, lockfiles and coverage reports; writes derived graphs and advisory/architecture caches | Realpath containment blocks traversal and symlink/junction escapes. The `pinned` profile removes `open_repo`; the default `offline` profile permits only explicit local switching. The optional malware dependency scan may inspect installed dependency caches such as GOPATH |
| URL strings | Fixed OSV/documentation URLs plus a user-configured sync URL | A URL string causes no request by itself; only the three network-profile tools perform requests |

`read_source` accepts repo-relative regular files only, caps a read at 2 MB, and refuses lexical or
realpath escapes. Graph-derived paths pass through the same boundary before analysis tools read
them. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Languages

JavaScript · TypeScript · TSX · Python · Go · Java · C# · Rust · HTML · CSS — parsed with
[web-tree-sitter](https://github.com/tree-sitter/tree-sitter) WASM grammars; no Python install, no
native compilation.

## On-disk layout

Graphs are derived data and never live inside your repo: the global per-user registry stores them at
`~/.weavatrix/graphs/<repository-storage-key>/` (including `.repository-id`, `graph.json`, and
`graph.prev.json`).

## Development

```sh
npm install
npm test                 # unit/integration tests plus the quick golden benchmark
npm run benchmark        # full TS/JS/Python/Go/Java/Rust + MCP lifecycle gate
npm run benchmark:real   # locally available real repos vs source-free 0.2.1 baselines
```

The benchmark checks representative graph correctness, complete edge provenance, cross-repository
HTTP tracing, output bytes, latency, freshness, reconnect and active-target stability. Its budgets, semantics and intentionally
limited claims are documented in [docs/benchmarking.md](docs/benchmarking.md).

Refactoring target: keep focused implementation modules near 300 lines and split larger concerns
into dotted-suffix modules behind a slim facade (`foo.js` re-exports `foo.parse.js`,
`foo.report.js`, …). A few older orchestration modules remain above that target; new work should
reduce them instead of growing new monoliths. The MCP layer lives
in `src/mcp/` (graph context, tool entry modules, focused helpers, and the catalog/hot-reload
loader) behind the thin stdio entry `src/mcp-server.mjs`.

## Roadmap

- **Public 0.2.2 regression foundation** now has the permanent six-language golden corpus,
  cross-repository wrapper/liveness fixture, framework/convention fixture, full MCP lifecycle gate
  and a portable real-repository runner. Five source-free 0.2.1 real-repository baselines are
  recorded; edge provenance is gated end-to-end. The unavailable Rust source checkout is the only
  explicit local gap preventing the strict six-repository release command from passing here.
- **Wrapper-aware API contracts** shipped in 0.2.2: persistent/ad-hoc configuration,
  conservative discovery, cross-repository handler liveness and explicit unknown states. The next
  hosted increment joins privacy-safe contract identities across separately synced services.
- **Hosted architecture workbench** is live at
  [app.weavatrix.com](https://app.weavatrix.com): explicit source-free sync,
  immutable history, Flow/DSM/Map, target architecture and bounded review
  evidence. Hosted use remains optional and owner-authenticated.
- **Semantic precision bridge** shipped for TypeScript/JavaScript in 0.2.4: a bounded, revision-bound
  local overlay validates references with the bundled language server while the parser graph remains
  the fallback. Java and Rust providers are not bundled yet and stay explicitly `UNAVAILABLE`.
- **Git-native architecture history** — bounded tag/ref timelines and branch
  reports built outside the worktree; graph artifacts stay out of Git.
- **Cross-repository company evidence** — endpoints, events and internal
  packages joined to affected consumers and ownership without uploading source.
- **CI blast radius** — bounded `change_impact` and architecture-ratchet evidence
  as a PR check/comment.

The public alignment note for the fixed cross-product release sequence is in
[docs/product-roadmap.md](docs/product-roadmap.md).

## License

[MIT](LICENSE) © 2026 Sergii Ziborov
