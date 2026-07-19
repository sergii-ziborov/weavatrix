# Weavatrix

**Local repository intelligence for AI coding agents — understand the application quickly, then change it with evidence.**

Weavatrix builds a reusable living graph of any local repository: files, symbols, imports, calls,
inheritance, health findings, clone families and Git-history coupling. It gives Claude Code, Codex,
or any MCP client a bounded map for fast application understanding and lower repeated context, then
reuses the same graph for change impact, Health, dead-code review, duplicates, history and intended-
architecture safeguards. Text search is included as a supporting source check, not the product core.
**34 network-free tools. No repository data leaves your machine.**

- Website: [weavatrix.com](https://weavatrix.com)
- Source: [github.com/sergii-ziborov/weavatrix](https://github.com/sergii-ziborov/weavatrix)
- npm: [`weavatrix`](https://www.npmjs.com/package/weavatrix) — `npx -y weavatrix <repoRoot>`

## 0.3: the MIT core

This package is the complete offline engine: graph,
local semantic precision, Health, dependencies, duplicates, impact, history and
architecture safeguards remain here under the existing MIT license. The MIT
license is not changing.

Every outbound HTTP capability belongs to the separately versioned package
`weavatrix-online`, beginning at 0.1.0. That connector targets either the
managed Weavatrix Cloud or a commercially licensed self-hosted Weavatrix
Enterprise deployment through one source-free wire contract. It is an expanded
superset that depends on this package, not a fork: it may add proprietary tools,
skills and analyzers through the supported extension API while graph/parser/LSP/
Health fixes continue to ship once in the MIT core.

The decision and release gates are in
[docs/adr/0001-v0.3-offline-online-split.md](docs/adr/0001-v0.3-offline-online-split.md).

## One graph, many views

The 34 MCP methods are not one linear workflow. They project the same reusable graph into the
smallest view needed for a task: repository and build state; modules, communities, hubs, neighbors
and paths; exact symbols and bounded source context; endpoint and cross-repository API flow; symbol
and change-set blast radius; graph revision and behavioral Git history; Health, dependencies,
vulnerabilities, dead code, clones, coverage and hot paths; proof-carrying change verification;
intended-architecture contracts and ratchets; and local multi-repository work.

## Why

An AI agent editing code without architecture, health and history evidence is refactoring blind.
Weavatrix answers questions a text index cannot:

- *"What breaks if I change this?"* → `change_impact` diffs your branch (staged, unstaged and
  untracked included), maps the changed files and symbols onto the graph, and lists everything that
  depends on them — with test coverage attached, so the **untested part of the blast radius** stands
  out before you ship.
- *"Who calls this function?"* → `inspect_symbol` returns exact bounded TS/JS occurrences plus
  source context; `context_bundle` adds production-first graph relations, exact re-export sites,
  diverse call-site excerpts, and a smaller source workset. `get_dependents` walks the symbol-level reverse graph transitively. Opt into
  `include_container_importers:true` only when a broader module-import radius is intended.
- *"Did my refactor actually decouple anything?"* → `graph_diff base_ref=HEAD~1` builds an immutable
  baseline graph without checking it out, then reports the structural delta: new module
  dependencies, broken or introduced import cycles, and symbols that lost their last caller.
- *"Where is the repo rotting or repeating itself?"* → `run_audit`, `find_dead_code`,
  `find_duplicates`, `hot_path_review` and `git_history` combine deterministic findings, graph
  connectivity and co-change evidence instead of treating a matching string as an architecture fact.

- *"Is this change actually safe?"* -> `verified_change` accepts the task plus current diff/files and
  returns one proof-carrying `PASS`, `BLOCKED`, or `UNKNOWN`: compact edit contexts, exact-symbol
  impact, bounded call-argument flow, Git graph drift, architecture/duplicate/API ratchets, and
  affected-test evidence.

## Worked examples

These are representative sequences from local dogfooding, not fabricated chat transcripts. Counts
describe the observed repository snapshots and will move with the code.

### Understand an unfamiliar backend without reading it linearly

```text
Question: Where does an attack-mitigation request go?

module_map
  -> production territories and strongest module dependencies
list_endpoints
  -> 462 routes observed in a 1,076-file backend snapshot
trace_endpoint
  -> composed router mount -> controller -> service -> task/messaging
  -> bounded call-site excerpts around decisive edges
```

Use `module_map` for the initial application shape, then switch to the exact endpoint or symbol. Do
not lead with a broad natural-language `query_graph` when the route or identifier is already known.

### Check whether a backend handler is used by another repository

```text
Question: Can this handler be removed?

list_known_repos -> trace_api_contract
  backend endpoints observed: 163
  client callsites joined:     267 across two registered clients
  handler liveness:            NOT_DEAD_EXTERNAL_USE
  unresolved dynamic URLs:     POSSIBLE_EXTERNAL_USE / UNKNOWN
```

This joins separately cached local graphs; it does not upload source. Medium/high-confidence
external use can keep a handler out of the dead-code queue, while dynamic or ambiguous calls remain
explicitly incomplete evidence.

### Change one method with an evidence trail

```text
inspect_symbol -> context_bundle -> get_dependents -> coverage_map
  -> edit the bounded workset
  -> verified_change phase=verify base_ref=<merge-base>
```

On an observed BranchPilot diff, `change_impact` separated removed methods/signatures from additive
exports and ranked a 98-node radius without collapsing runtime and type-only coupling. If measured
coverage, the architecture contract, or requested tests are missing, the final state is `UNKNOWN`,
not a cosmetic pass.

### Review Health and clone debt without auto-deleting code

```text
run_audit category=dependencies debt=all
  -> missing direct dependency (observed: mongodb)
  -> lockfile drift and unresolved imports
run_audit debt=all
  -> runtime cycles separated from compile/type-only coupling
find_duplicates
  -> clone families and same-name divergence
  -> homogeneous router boilerplate suppressed by default
```

Every dead-code, orphan, dependency and duplicate item remains review evidence. Confirm framework
conventions and source use before editing; Weavatrix does not auto-delete or merge findings.

`run_audit` also returns an explicit capability matrix. `STRUCTURE CHECKED` and a supported package
ecosystem do not imply `RUNTIME_CORRECTNESS` or `CONCURRENCY` is complete. npm, nested Python and Go
modules, Maven properties, common Gradle declarations/version catalogs, and Cargo workspace/renamed
packages are compared with indexed imports. JVM reflection/generated/runtime-only use, Cargo
features/proc macros and unresolved build logic remain review evidence; bounded Go/Java checks are
neither compiler proof nor a race detector.

### Where this saves agent context — and where it does not

The largest saving comes from graph operations that replace repeated discovery: one
`change_impact`, `get_dependents`, `context_bundle`, contract trace or dependency audit can collapse
many search/read hops into a bounded evidence set. `read_source` is mainly a convenient exact window
and is not inherently cheaper than a client's native offset read. Database queries, runtime state,
disk forensics and background workflow investigation remain outside a static repository graph.
Typecheck, tests and runtime checks remain the release authority.

### Trace an event, queue, worker, cron or CLI flow

```text
query_graph
  seed_symbols=["handleAttackEvents"]
  relation_filter=["calls", "references"]
  flow_direction="both"
  -> exact listener plus bounded producers and consumers
context_bundle label="handleAttackEvents"
  -> production callers first and diverse excerpts around decisive call sites
```

Exact symbol seeds avoid fuzzy routing noise and work for non-HTTP entry points without adding a
special-purpose tool for every framework. A narrow `search_code` registration check is still useful
when the handler name is not known; it is a discovery aid, not the graph.

### Establish an architecture contract without silently changing policy

```text
get_architecture_contract action=preview baseline_mode=none
  -> adaptive Maven/Gradle/monorepo territories
  -> observed dependency directions labelled OBSERVED_NOT_ENFORCED
  -> exact proposed file, verification, hash and short-lived token
get_architecture_contract action=approve confirm_token=<reviewed-token>
  -> creates only a missing .weavatrix/architecture.json
prepare_change -> edit -> verify_architecture
```

Use `baseline_mode=accept-current` only when the owner explicitly accepts current deterministic debt.
Approval rechecks the graph and never overwrites an existing local or Hosted policy.

## Benchmarks

Two different gates ship in the repository:

- `npm run benchmark` is a reproducible golden suite for TypeScript, JavaScript, Python, Go, Java
  and Rust, plus cross-repository HTTP matching, framework conventions and the MCP graph lifecycle.
- `npm run benchmark:real` compares revision-pinned local application snapshots with the checked-in
  0.2.1 relation baseline. It fails on unexplained signal loss; `MISSING`, `STALE` and `UNBASELINED`
  remain incomplete, not green.

Representative local regression run (Windows x64, Node 24.15.0, July 18, 2026):

| Gate | Result | Selected evidence |
|---|---:|---|
| Six language fixtures | 6/6 PASS | exact symbols/edges and complete edge provenance |
| Cross-repo fixture | PASS, 431.79 ms cold | endpoint match, typed wrapper, external use, affected screen |
| Lifecycle | PASS | `full -> incremental -> none -> reconnect/none`; 1,376-byte text response |
| Total fixture cold build | 1.31 s | all six language graphs; 6.4 KB bounded report |
| Real-repository baseline | 6/6 PASS | TS, JS, Python, Go, Java and Rust snapshots |

Real snapshots ranged from 473 nodes / 1,165 edges in 0.22 s (Go) to 8,192 nodes / 21,814 edges
in 9.44 s (TypeScript). The Java snapshot built 7,143 nodes / 23,708 edges in 2.61 s, including
receiver-aware cross-file calls. These are regression measurements on one machine, not competitor
benchmarks or universal latency claims. See [benchmark/cases.mjs](benchmark/cases.mjs),
[benchmark/real-repositories.json](benchmark/real-repositories.json), and run the commands above to
reproduce them on your own repositories.

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

The package has one binary and two local security profiles. The omitted profile is `offline`:
all local analysis plus `open_repo`. Pass `pinned` as the final argument for a stricter repository
boundary:

| Profile | Local repository switching | Cross-repo graph reads | Network requests |
|---|---:|---:|---:|
| `offline` (default) | Yes, only through `open_repo` | Yes, only through `trace_api_contract` | None |
| `pinned` | No | No | None |

```sh
# Hard-pin one repository and expose no network tools:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> pinned

```

Advanced registrations may still pass an exact comma-separated capability set:
`graph,search,source,health,build,retarget,crossrepo`. The former `online`, `osv`, `hosted` and `full`
profiles fail loudly and direct the user to `weavatrix-online`; none can re-enable HTTP in this artifact.

After an upgrade, reconnect the MCP server or start a new agent task before checking its tool list:
many clients snapshot `tools/list` and input schemas for the lifetime of one connection. The expected
counts are 31 for `pinned` and 34 for `offline`. A custom capability list must include `crossrepo` to
expose `trace_api_contract`. `graph_stats` reports the running package version, enabled capabilities
and registered-tool count so a cached process can be distinguished from the installed package.

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
`open_repo` also upgrades graphs that predate current typed-edge/provenance/physical-LOC metadata; `build:false`
probes without building and refuses a legacy graph. Retargeting is offline but intentionally changes
the filesystem boundary for subsequent tools; select `pinned` when that boundary must not move.

An agent skill with recipes ships in [skill/SKILL.md](skill/SKILL.md) — install it as
`~/.claude/skills/weavatrix/SKILL.md` for Claude Code or
`~/.codex/skills/weavatrix/SKILL.md` for Codex.

## Tools

**graph** — `graph_stats`, `get_node`, `get_neighbors`, `query_graph`, `god_nodes`,
`shortest_path`, `get_community`, `list_communities`, `module_map`, `get_dependents`,
`change_impact`, `verified_change`, `git_history`, `graph_diff`, `get_architecture_contract`,
`prepare_change`. Runtime dependencies, TypeScript type-only coupling and language
compile-only edges (Rust module/use, Java imports) are reported separately where that distinction
changes the result. TypeScript type-space and value-space declarations keep distinct identities;
classes and enums that inhabit both spaces are labelled `both`.

Every current edge carries versioned provenance. The parser emits `EXTRACTED`, `RESOLVED`, and
`INFERRED`; the built-in bounded TypeScript/JavaScript precision overlay upgrades only references
confirmed by its bundled `typescript-language-server` + TypeScript runtime to `EXACT_LSP`.
`CONFLICT` means evidence disagrees. `graph_stats` reports the provenance breakdown and the semantic
provider's `COMPLETE`, `PARTIAL`, `UNAVAILABLE`, or `OFF` state; `OFF` means precision was explicitly
disabled and only static evidence is active. Java and Rust language-server providers are not bundled:
their edges never become `EXACT_LSP`, even when a mixed repository reports a complete
TypeScript/JavaScript overlay.

Configured TypeScript plugins (including Next.js) are recorded but suppressed; repository-local
plugin code is never loaded. The broad overlay is deliberately budgeted, so `PARTIAL` can mean the
candidate cap was reached. `get_dependents` then spends a bounded point query on the requested JS/TS
symbol and replaces direct heuristic references only when exact absence/presence is proven.
`change_impact` batches the same exact query for changed symbols. Further transitive hops remain
graph-backed and are labelled as such.

The bounded JS/TS provider is enabled by default for new graphs. Set `WEAVATRIX_PRECISION=off`
before starting the MCP server for parser-only operation from the first build, or pass
`precision:"off"` to `rebuild_graph` / `open_repo`. The MCPB installer exposes the same `lsp` / `off`
choice as **TypeScript/JavaScript semantic precision**.

**search / source** — `search_code` (ripgrep-backed, pure-Node fallback, with repository-relative
path globs on Windows/macOS/Linux), `read_source` (a
symbol's actual code in one hop), `context_bundle` (definition plus grouped inbound/outbound
containers ranked production-first, exact re-export sites, call-site/target provenance and diverse bounded excerpts around decisive
edges), `inspect_symbol` (one exact
bounded TS/JS reference query, logical containers, impact and source excerpts), `list_endpoints` (HTTP route inventory:
Express/Fastify/Nest/Flask/FastAPI/Go mux/Rust axum and actix-web, including nested Express
`router.use(...)` mount composition, declaration/reachability counts, mount provenance, and Spring
conditional/default-active state),
`trace_endpoint` (one exact composed route → handler → bounded production call graph with call-site excerpts)

**health** — `find_dead_code` (bounded review queue for statically unreferenced and test-only files,
functions, methods, and symbols, with evidence tiers, completed/remaining verification and explicit
public/framework/dynamic caveats),
`run_audit` (an explicit capability matrix plus unused files/exports/dependencies with per-finding manifest/indexed-source/script/config verification;
`category:dependencies` isolates missing/unused/duplicate declarations, unresolved imports and lockfile drift,
missing npm/Go/Python/Maven/Gradle/Cargo deps, bounded import-to-artifact/crate verification, concrete
npm/PyPI/Go/Maven/crates.io advisory pins, Go/Java correctness candidates, runtime
cycles, type-only/compile-only coupling, orphans, boundary rules, offline OSV vulnerabilities + typosquat +
lockfile drift; accepts an immutable `base_ref`, `changed_files`, and `debt: new|existing|all` for
review-scoped results; production paths are the default and `include_classified:true` opts into
test/generated/docs evidence), `find_duplicates` (MOSS winnowing over method bodies — catches copy-paste even
after renames and can inspect strict small clones down to 12 tokens; homogeneous router boilerplate
is suppressed unless `include_boilerplate:true`; immutable declarative catalog shapes require `include_declarative:true`), `coverage_map` (existing coverage reports mapped onto the graph; untested hotspots
ranked by connectivity — tests are never executed), `hot_path_review` (bounded local-cost evidence
with separate graph/test risk), `verify_architecture`,
`explain_architecture_violation`, `propose_architecture_exception`

`hot_path_review` ranks production symbols using parser-derived local time, memory, cyclomatic and
call-site facts plus exact inside-loop allocation, copy, scan, sort and recursion evidence. Graph
fan-in/fan-out and measured coverage (or explicitly labelled static test reachability) remain
separate from local syntax cost. Its focused default uses `min_score:85` plus a narrow strong-local
fallback; pass `min_score:0` only when the full diagnostic queue is wanted. The ranking is not
profiler data or interprocedural Big-O.

**build** — `rebuild_graph` (reports the structural delta, keeps the prior state as
`graph.prev.json`)

For dead functions/methods/symbols, call `find_dead_code` first. Its default production-only queue
shows high/medium-confidence candidates and excludes tests, generated code, mocks, stories and docs;
use `kinds:["method"]` or a `path` prefix to narrow it. `min_confidence:"low"` explicitly includes
public APIs and framework/dynamic/reflection-sensitive candidates with their warnings. For repository
maintenance or branch debt, pair it with `run_audit category=unused debt=all` (or add an immutable
`base_ref` with `debt=new`) to cover unused files, exports and dependencies. Neither tool authorizes
deletion: `STRONG_STATIC_EVIDENCE` means an exact zero-reference result, not permission to remove;
follow each candidate's `remainingChecks`, then inspect source/dependents/configuration and run tests.

`graph_diff` accepts `base_ref` (`HEAD~1`, `main`, `origin/main`, or another local Git ref) for a
fresh baseline comparison. Without it, the tool compares against `graph.prev.json` saved by the last
full rebuild. Either mode can be narrowed with `path`.

Graph and health calls reconcile the working graph before answering. Safe JS/TS body-only changes
reparse only the changed files plus bounded reverse importers; add/delete, export-surface, barrel,
manifest, alias, ignore/config, non-JS/TS, or unsafe merge cases deliberately fall back to a full
rebuild. The result says whether freshness was `none`, `incremental`, or `full`. Graph artifacts stay
in the per-user cache and never need to be committed to Git.

`verified_change` is read-only by default. It may run only explicitly requested `package.json`
scripts whose names are allowlisted as test/check/verify scripts, and only when both
`run_tests:true` and `WEAVATRIX_ALLOW_TEST_RUNS=1` are present. It never accepts an arbitrary shell
command. Cross-repository API proof is used only when the active profile includes `crossrepo`;
without a configured architecture contract or complete evidence, the result is `UNKNOWN`, not a
cosmetic pass. Its data-flow section maps bounded JS/TS call arguments to callee parameters; it is
not CFG, value-propagation, or taint analysis.

**retarget** *(included in `offline`; absent from `pinned`; every switch is an explicit local call)* —
`open_repo`, `list_known_repos`; changes the active repository boundary

**crossrepo** *(included in `offline`; absent from `pinned`; reads only registered local graphs)* —
`trace_api_contract`; reconciles the selected backend/client graphs and joins routes to client callsites

`query_graph` accepts optional `seed_files` and exact `seed_symbols` when an architectural or
event-driven question must start from known entry points. `relation_filter` limits edge kinds and
`flow_direction:forward|backward|both` turns the same graph into a bounded producer/consumer view.
Resolved explicit seeds are exclusive by default; set `augment_seeds:true` only when
question-derived seeds are also wanted. A code-shaped identifier such as `startMitigate` is treated
as a stronger bounded seed than surrounding words such as controller/service/flow; all exact
same-name declarations are retained instead of adding unrelated concept seeds. Broad
bootstrap/tool-execution/routing questions rank
conventional executables and graph-declared production entry points ahead of site, documentation, benchmark
and fixture matches. Production-first classification also applies during traversal, so unrelated
tests/generated/docs/benchmarks do not leak back from a production seed; name a class in the
question or set `include_classified:true` to include it. Unreferenced unmatched constant/field leaves
are hidden unless `include_low_signal:true`. Broad ranking remains orientation evidence; use
`seed_files`, `seed_symbols`, an exact endpoint, or `inspect_symbol` when the intended entry point is already known.
Instruction words such as “REST”, “path”, and “inspect” do not become fuzzy code seeds.

Remote advisory refresh, source-free sync and shared architecture-contract exchange are supplied by
the separate `weavatrix-online` superset. The core keeps offline advisory matching and the local
extension services used to validate imported records and source-free payloads.

Quality of life: graph/health reads auto-reconcile and expose `none` / `incremental` / `full`
freshness, with a short clean-read debounce to avoid rescanning the repository for every tool call;
ambiguous name lookups are
disclosed instead of silently guessed; and the server **hot-reloads its watched MCP tool entry
modules and catalog** when those files change — other MCP helpers and analysis engines require a
reconnect. Every MCP response also carries local, transient `_meta["weavatrix/metrics"]` with elapsed
time, output bytes/token estimate, graph freshness/revision/update and graph-cache status. These
metrics are not persisted or transmitted by Weavatrix. If a source checkout's package version moves
while an old daemon remains alive, `initialize`, `tools/list`, and tool calls fail loudly with
`STALE_RUNTIME` until the client reconnects; the opt-out is reserved for deliberate development.

### 0.3.1 exact impact over oversized diffs

- `change_impact` now recovers a bounded per-file unified diff when one large asset exceeds the
  aggregate diff budget. Normal source files retain line/symbol classification; only the files that
  individually exceed the budget stay conservative `unknown`.
- Real Hosted dogfood recovered all 27 changed paths, mapped 57 changed symbols, reduced the
  conservative seed set from 1,000 to 72, and verified exact direct references for 16/16 selected
  JavaScript/TypeScript symbols. Transitive hops remain explicitly graph-backed.
- The global LSP overlay remains a bounded prewarm and can honestly be `PARTIAL`; `get_dependents`,
  `inspect_symbol`, and `change_impact` run revision-bound exact point/batch queries beyond that cap.

Full patch notes: [docs/releases/v0.3.1.md](docs/releases/v0.3.1.md).

### 0.3.0 network-free core and exact dependency evidence

- The MIT package now contains 34 local tools and no outbound HTTP implementation. Online OSV,
  Cloud and licensed self-hosted workflows live in the separately installed `weavatrix-online`
  0.1.0 superset, which depends on this core through a supported extension API.
- Cargo.lock provides exact crates.io pins; saved `cargo audit --json` results add RustSec evidence.
  Missing or stale advisory evidence stays incomplete.
- Maven/Gradle imports map to exact class ownership from already installed JARs. Missing JARs,
  unresolved build expressions and heuristic fallbacks are `PARTIAL`, never a false `COMPLETE`.
- Real self-dogfood produced persisted `EXACT_LSP` edges and an exact direct caller for
  `startMcpServer`. GraphQL, gRPC and event/Kafka joins use static evidence plus revision-bound
  runtime/OTLP observations; unobserved dynamic targets remain explicit `UNKNOWN`.

Full patch notes: [docs/releases/v0.3.0.md](docs/releases/v0.3.0.md).

### 0.2.19 supply-chain signal precision

- Installed-package URL literals and ordinary standalone network calls no longer become malware
  findings without a separate security signal. They remain bounded co-evidence beside behavior such
  as environment harvesting, while exfil endpoints, public raw IPs and fetch-plus-exec stay active.
- Unicode variation selectors used for emoji/presentation are no longer confused with hidden text
  controls. Bidirectional override/isolate controls remain covered.
- Real Hosted dogfood now completes OSV over 651 package versions and the local malware sweep over
  535 installed packages with zero critical/high/medium/low findings.

Full patch notes: [docs/releases/v0.2.19.md](docs/releases/v0.2.19.md).

### 0.2.18 repository-root and self-audit trust patch

- A directory nested under an ignored parent Git repository is no longer mistaken for an empty
  repository. The internal builder now falls back to its boundary-safe walker for that ambiguous
  case while preserving Git ignore semantics at a real repository root.
- This is the first npm release containing the 0.2.17 self-audit work: Drizzle reachability,
  scoped typosquat precision, regex-aware clone anchors, dead parser removal and shared owners.
- The 0.3 boundary remains unchanged: this offline package stays MIT, and the separately licensed
  online connector owns outbound HTTP after the major split.

Full patch notes: [docs/releases/v0.2.18.md](docs/releases/v0.2.18.md).

### 0.2.17 self-audit trust patch (tagged, not published to npm)

- Health no longer treats configured Drizzle schema modules as orphaned/test-only production code,
  and scoped typosquat checks no longer compare legitimate scoped packages with unrelated unscoped
  names.
- Duplicate detection retains equality anchors for executable regular-expression bodies, preventing
  unrelated validation/normalization pipelines from becoming perfect renamed clones.
- Dogfooding removed obsolete test-only parsers and consolidated dependency-scope, graph-ID,
  architecture-contract, bounded-option and safe repository-read helpers.
- The accepted 0.3 product boundary keeps the offline engine MIT and moves all outbound HTTP tools
  into the separately licensed `weavatrix-online` connector.

Full patch notes: [docs/releases/v0.2.17.md](docs/releases/v0.2.17.md).

### 0.2.16 exact dependents, multi-ecosystem dependencies and transport contracts

- Safe TypeScript project plugins no longer disable semantic precision. Plugin loading remains
  suppressed, while `get_dependents` and `change_impact` can obtain exact direct JS/TS references on
  demand and identify graph-backed transitive hops separately.
- Dependency evidence covers nested npm/Python/Go scopes, Maven properties, Gradle catalogs/locks,
  and Cargo workspace inheritance/renames/locks. Explicit OSV refresh accepts npm, PyPI, Go, Maven
  and crates.io pins.
- Cross-repository tracing adds static GraphQL, gRPC and event-topic joins alongside HTTP and keeps
  runtime configuration, reflection and other dynamic targets explicitly `UNKNOWN`.
- npm/MCPB metadata now calls out Codex/OpenAI Codex workflows, and Hosted distinguishes aggregate
  folder-boundary feedback from proven file-level runtime cycles.

Full patch notes: [docs/releases/v0.2.16.md](docs/releases/v0.2.16.md).

### 0.2.15 self-audit precision patch

- Dependency review now scopes nested manifests correctly, recognizes framework peer packages and
  package references assembled from bounded dynamic path fragments, and avoids misclassifying
  dependency-owned source as an unused root declaration.
- Reachability follows source-owned HTML asset references, so maintained browser entry scripts and
  styles remain part of the production surface instead of appearing as dead files.
- Malware heuristics distinguish inert placeholders, comments, documentation URLs, and ordinary
  Unicode text from executable registry or download behavior while retaining explicit review
  evidence for actionable patterns.
- Duplicate review ignores policy-like numeric tables and stable ordered-member declarations where
  repetition is intentional, and the remaining reverse-reach, Git-output, member-order, path-term,
  and retrieval logic now uses shared owners instead of drifting copies.

Full patch notes: [docs/releases/v0.2.15.md](docs/releases/v0.2.15.md).

### 0.2.14 typed flows, honest Health, and architecture bootstrap

- Go call resolution now follows receiver types through parameters, locals, constructor returns,
  imported types and struct fields. It links calls such as `bgpSpeaker.RemoveMitigator(update)` to
  `(*Speaker).RemoveMitigator` without guessing across ambiguous same-name receivers.
- `query_graph` adds exact `seed_symbols`, `relation_filter`, and directed traversal for generic
  event/queue/worker/cron/CLI flows. `context_bundle` ranks production callers before tests and uses
  diverse edge-centered excerpts. `FlowSpec` no longer accidentally requests test traversal.
- Health exposes per-capability completeness. Maven/Gradle support is honest instead of returning a
  clean zero, and bounded Go/Java correctness findings never claim compiler, runtime, race, or
  concurrency proof. Spring endpoints expose conditional/default-inactive controllers.
- Architecture bootstrap adapts to Maven/Gradle/monorepo source roots and uses a reviewable
  preview/approve handshake. A stale daemon now refuses analysis when its runtime version differs
  from the package on disk.
- The MCP implementation and static site are split into owner-focused modules/assets. A release test
  enforces a physical 300-line maximum for JavaScript/TypeScript under `src`, `bin`, `scripts`, and
  `test`, plus maintained HTML/CSS/JavaScript under `site`.

Full patch notes: [docs/releases/v0.2.14.md](docs/releases/v0.2.14.md).

### 0.2.9 correctness, signal, and consent patch

- Express endpoint inventory composes nested imported `router.use(...)` mounts, so a local route such
  as `/:attackId/startMitigate` is reported with its reachable `/warRoom/attack` prefix, declared vs
  reachable counts and the exact static mount chain. `trace_endpoint` continues from that route into
  the bounded call graph and call-site excerpts.
- `context_bundle` keeps the call-site file/line separate from the target definition and adds bounded
  excerpts around decisive edges instead of stopping inside a long leading comment.
- `search_code` applies documented repository-relative path globs correctly when ripgrep runs on
  Windows. Broad `query_graph` prompts no longer turn generic REST/instruction words into noisy
  configuration-file seeds, and code-shaped identifiers outrank generic controller/service/flow
  concepts.
- `run_audit` is production-first by default while retaining explicit access to classified evidence;
  `category:dependencies` provides a focused dependency-health slice;
  duplicate review suppresses homogeneous Express router boilerplate unless requested.
- the separate no-network `preview_sync` produces the exact payload approval artifact; `sync_graph`
  requires that preview followed by an exact short-lived confirmation token,
  validates the configured destination, requires HTTPS outside loopback, and never networks during
  preview. Contract-pull HTTP failures expose actionable auth/not-found/not-ready states.
- Every MCP call exposes transient local execution/output/freshness metrics without collection or
  egress. The public site, privacy/security pages, package metadata and license presentation now
  describe the same 38-tool/34-offline surface and the same network boundary.

Full patch notes: [docs/releases/v0.2.9.md](docs/releases/v0.2.9.md).

### 0.2.8 trust and precision patch

- Dead-code review no longer labels a declaration `test-only` when it has a same-file production
  use. Revision-bound positive evidence from an exact `inspect_symbol` point query also removes that
  declaration from later dead-code candidates instead of remaining isolated in its cache.
- Python dependency checks discover nested `requirements*.txt`, `requirements/*.txt`,
  `pyproject.toml`, and `Pipfile` manifests and assign imports to their nearest manifest scope.
  A root `test.py` is classified consistently as test code.
- Endpoint extraction masks commented-out routes without shifting source offsets and rejects
  primitive path-to-name maps such as `{'/.codex': 'claude'}` while retaining real route tables.
- Rust symbols now expose concrete kinds, owner types, visibility/export state, selection ranges and
  structural owner/member edges. This is parser evidence; Rust semantic/LSP precision remains
  explicitly unavailable.
- Natural-language retrieval honors explicit Rust, Python, TypeScript, JavaScript, Go, Java, and C#
  intent in mixed repositories. Compact `verified_change` text now includes decisive exact reference
  counts and bounded inbound caller names for every selected edit symbol.

Full patch notes: [docs/releases/v0.2.8.md](docs/releases/v0.2.8.md).

### 0.2.7 verified-change workflow

- New `verified_change` composes task retrieval, exact symbol context, change impact, immutable Git
  graph comparison, architecture/duplicate/API ratchets, and targeted-test evidence behind one
  `PASS` / `BLOCKED` / `UNKNOWN` contract.
- Intent-expanded graph retrieval is combined with exact changed-symbol seeds. A bounded JS/TS
  interprocedural layer records call arguments and their callee parameters without claiming CFG or
  taint completeness.
- Test execution is a double opt-in and limited to existing test/check/verify package scripts;
  default operation remains read-only.
- Malware scanning now sweeps installed npm package roots instead of package-manager caches or
  hosted release snapshots. Static heuristic findings are capped at `high`, expose unverified
  execution/origin/lockfile/exposure state, and no longer prescribe secret rotation unless execution
  or credential exposure has actually been confirmed.
- `query_graph` and `verified_change` task retrieval now enforce production-first classification
  through traversal/selection while retaining exact changed or pinned non-product symbols; query
  output also suppresses unmatched constant/field leaves. `hot_path_review` defaults to a focused
  85-point queue, while `min_score:0` remains the explicit full-diagnostic mode.
- Dead-code candidates now carry evidence tiers and remaining checks; dependency findings carry
  per-finding manifest plus indexed-source/script/config verification without authorizing removal.
- `npm run benchmark:agent` reports routing success, false positives, token estimate and latency.
  Codebase Memory and Serena results stay explicitly `MISSING` until independently collected data is
  supplied under the [blind agent-change protocol](docs/agent-task-benchmark.md);
  `benchmark:agent:release` fails closed without same-task change success, FP, token, and time results.

Full patch notes: [docs/releases/v0.2.7.md](docs/releases/v0.2.7.md).

### 0.2.6 compact-context and TypeScript identity patch

- New `context_bundle` turns a symbol into a bounded workset: definition, grouped inbound/outbound
  containers, reference evidence, exact re-export locations and a small number of source excerpts.
- Re-export records retain their concrete file, line, alias, specifier, type-only flag and resolved
  origin. Barrel propagation through `export *` stays exact and private declarations are not exposed.
- TypeScript interfaces and type aliases are first-class type-space nodes. Same-named runtime values
  keep separate identities, while classes and enums are explicitly marked as inhabiting both spaces.
- Graph schema v5 and freshness gates rebuild older caches before these precision-sensitive results
  are used. The changes remain local-only and add no runtime dependency.

Full patch notes: [docs/releases/v0.2.6.md](docs/releases/v0.2.6.md).

### 0.2.5 exact-symbol and graph-fidelity patch

- New `inspect_symbol` spends a bounded LSP query on one requested TS/JS declaration, groups exact
  occurrences by logical container, and returns definition/caller source context. Its separate LRU
  cache is revision/config fingerprinted and never replaces the broad precision overlay.
- Default-object service facades resolve to their underlying helpers, while `get_dependents` no
  longer silently expands every symbol query to all importers of its file.
- Python receiver-aware method dispatch and unambiguous wildcard imports distinguish same-named
  methods across classes without promoting ambiguous dynamic evidence.
- `run_audit` makes unused-dependency checking visible even when clean; dead-code review identifies
  production symbols referenced only by tests; small-clone scanning can be lowered to 12 tokens with
  stricter evidence rules.
- `hot_path_review` adds a bounded offline performance-review queue with line-addressable local cost
  evidence, separate graph risk, and honest measured/unavailable coverage states.

Full patch notes: [docs/releases/v0.2.5.md](docs/releases/v0.2.5.md).

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
  Field, parameter, local and static receiver types resolve project-internal cross-file calls;
  overloads are selected by arity and ambiguous/external targets fail closed. Imports are
  compile-only; call/reference/heritage edges contribute impact. Maven/Gradle Java trees use
  package-aware communities instead of one giant `src` bucket. External or synthetic placeholder
  types are not created merely to inflate graph counts.
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

### Cross-repository transports

`trace_api_contract` recognizes built-in object clients such as `axios.get(...)`, explicit bare or
object/member wrappers, and simple auto-discovered functions that forward a URL parameter directly
to a known HTTP client. Auto-discovered wrappers are restricted to their bounded reverse-import
scope; ambiguous same-name definitions are skipped and reported as incomplete evidence.

The same tool can select GraphQL, gRPC or event evidence. It joins static GraphQL schema fields and
operations, proto service methods and typed stub calls, and static Kafka/event-bus topic producers
and consumers across registered repositories. It also imports a bounded, source-free
`weavatrix.transport-runtime.v1` report from each repository. Normalized observations and OTLP JSON
spans can confirm runtime GraphQL fields, gRPC service/methods and Kafka/event destinations. A report
must match the active `graphRevision`, be fresh, declare per-transport capture completeness and map
dynamic observations to a repository-relative file/line before that exact `UNKNOWN` is resolved.

The default report paths are `.weavatrix/transport-runtime.json` and
`.weavatrix/reports/transport-runtime.json`; `runtime_evidence_files` can select another contained
path per repository label/UUID. The minimum envelope is:

```json
{
  "schema": "weavatrix.transport-runtime.v1",
  "repositoryRevision": "<active graphRevision>",
  "generatedAt": "2026-07-19T12:00:00.000Z",
  "coverage": { "graphql": "COMPLETE", "grpc": "COMPLETE", "event": "COMPLETE" },
  "observations": [
    { "transport": "graphql", "side": "client", "operation": "QUERY", "name": "viewer", "file": "src/api.ts", "line": 42 },
    { "transport": "grpc", "side": "server", "service": "User", "name": "GetUser" },
    { "transport": "event", "side": "publisher", "name": "user.created" }
  ]
}
```

OTLP `resourceSpans` may be placed at the envelope root or under `otlp`; standard `rpc.*`,
`graphql.*`, `messaging.*` and `code.*` span attributes are normalized. Missing, stale, mismatched,
partial or uncorrelated runtime evidence stays `PARTIAL`/`UNKNOWN`; it is never converted into an
absence claim. The two default report files are excluded from the graph file universe so they do not
change the revision they attest; a custom report path must be Git-ignored. Reports must omit payloads,
headers, source text and credentials.

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
Weavatrix 0.3 itself initiates no outbound HTTP. It can validate a connector-provided advisory cache,
construct a bounded source-free payload locally and cache a validated architecture contract, but
those local extension services have no transport or credential input. The separately installed
`weavatrix-online` superset owns OSV requests, Cloud/Enterprise authentication, capability
negotiation, consent and synchronization. It depends on this MIT core and may add proprietary tools,
skills and local analyzers without replacing baseline implementations.

Evidence sections carry independent `state` (`COMPLETE`, `PARTIAL`, `NOT_CHECKED`,
`NOT_APPLICABLE`, `ERROR`) and `verdict` (`PASS`, `FAIL`, `UNKNOWN`) fields plus exact
`total/returned/truncated` counts. An incomplete check is never converted into a clean zero. V3 is
deterministic: volatile timestamps are excluded and the allowlisted snapshot has a canonical SHA-256
fingerprint. This local service exists so a separately licensed connector can reuse the same bounded
wire validation without duplicating core logic; it cannot send the payload itself.

Profiles (`offline`, `pinned`) or exact local capability groups (`graph`, `search`, `source`, `health`,
`build`, `retarget`, `crossrepo`) are selectable through the final positional argument. Omitted caps
use `offline`; an explicit capability list exposes exactly the named groups. Legacy network profile
names fail loudly and direct the user to `weavatrix-online`.

## Security model

Socket capability alerts describe expected powers of a local code-analysis tool; they are not
vulnerability findings. This is where each capability comes from and how it is controlled:

| Capability alert | Why it exists | Activation and boundary |
|---|---|---|
| Network access | None in the MIT core | `offline` and `pinned` expose only local tools; Online/Cloud/Enterprise integration is a separate package |
| Shell access | Local `git` powers staleness/change impact; `rg` accelerates search; the bundled TLS/tsserver process supplies bounded JS/TS semantic evidence; timed-out Windows child trees may be terminated; `verified_change` can optionally run an existing package test/check/verify script | The semantic provider never invokes repository code. Test execution separately requires `run_tests:true` plus `WEAVATRIX_ALLOW_TEST_RUNS=1`, rejects arbitrary commands and shell-sensitive arguments, and should be enabled only for trusted repository scripts |
| Debug / dynamic loading | Cache-busted `import()` hot-reloads watched MCP tool entry modules; `createRequire` loads package metadata and parser dependencies | Loads files from the installed package; no `eval` |
| Environment access | Reads local `WEAVATRIX_*` runtime settings; ordinary helpers inherit a credential-stripped environment, while TLS/tsserver receives only allowlisted OS/temp/locale values and a constrained executable path | Connector secrets are removed from child-process and worker environments. TLS/tsserver also receives no registry/proxy/cloud credentials or `NODE_OPTIONS` |
| Filesystem access | Reads the active repository, graph, lockfiles and coverage reports; writes derived graphs and advisory/architecture caches | Realpath containment blocks traversal and symlink/junction escapes. The `pinned` profile removes `open_repo`; the default `offline` profile permits only explicit local switching. The optional malware dependency scan may inspect installed dependency caches such as GOPATH |
| URL strings | Advisory findings may contain fixed OSV documentation links | The core has no outbound request implementation |

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

Maintained JavaScript/TypeScript files under `src`, `bin`, `scripts`, and `test`, plus HTML/CSS/JavaScript
under `site`, have a hard physical 300-line ceiling enforced by the release suite. Larger concerns are
split into owner-focused modules behind slim stable facades (`foo.js` re-exports `foo.parse.js`,
`foo.report.js`, …). The MCP layer lives
in `src/mcp/` (graph context, tool entry modules, focused helpers, and the catalog/hot-reload
loader) behind the thin stdio entry `src/mcp-server.mjs`.

## Roadmap

- **Public 0.2.2 regression foundation** now has the permanent six-language golden corpus,
  cross-repository wrapper/liveness fixture, framework/convention fixture, full MCP lifecycle gate
  and a portable real-repository runner. Six source-free 0.2.1 real-repository baselines are
  recorded; edge provenance is gated end-to-end and the strict six-repository release command passes.
- **Cross-transport contracts** combine bounded HTTP/static models with revision-bound GraphQL,
  gRPC and Kafka/event runtime or OTLP evidence; unobserved dynamic identities stay explicit
  `UNKNOWN`.
- **Hosted architecture workbench** at
  [app.weavatrix.com](https://app.weavatrix.com) is an access-controlled preview for
  owner-authenticated source-free evidence and revision history. Its UI and backend evolve
  independently from the public MCP release; local use remains fully optional.
- **Semantic precision bridge** shipped for TypeScript/JavaScript in 0.2.4: a bounded, revision-bound
  local overlay validates references with the bundled language server while the parser graph remains
  the fallback. 0.2.16 adds safe configured-plugin suppression plus exact on-demand point and changed-
  symbol batch queries. Java and Rust language-server providers are not bundled and stay explicitly
  unavailable as semantic providers; their parser/dependency evidence is still active.
- **Git-native architecture history** — bounded tag/ref timelines and branch
  reports built outside the worktree; graph artifacts stay out of Git.
- **Cross-repository company evidence** — endpoints, events and internal
  packages joined to affected consumers and ownership without uploading source.
- **CI blast radius** — bounded `change_impact` and architecture-ratchet evidence
  as a PR check/comment.

The public alignment note for the fixed cross-product release sequence is in
[docs/product-roadmap.md](docs/product-roadmap.md).

## License

The Weavatrix source in this repository is [MIT licensed](LICENSE) © 2026 Sergii Ziborov.
Third-party dependencies retain their own licenses. See the public
[license page](https://weavatrix.com/license) for the same notice.
