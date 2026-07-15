# Weavatrix

**Code graph & blast-radius MCP server for AI coding agents.**

Grep sees text. Weavatrix sees structure. It builds a dependency graph of any local repository —
files, symbols, and the imports/calls/inheritance connecting them — and serves it to Claude Code,
Codex, or any MCP client: change impact, transitive dependents, health audit, clone detection,
coverage mapping. **23 tools available; 21 offline tools enabled by default, including one-call
repository switching. Local-first: with the defaults, no repository data leaves your machine.**

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
- *"Did my refactor actually decouple anything?"* → `rebuild_graph` + `graph_diff` report the
  structural delta: new module dependencies, broken or introduced import cycles, symbols that lost
  their last caller.

## Quick start

Requires Node ≥ 18. One command:

```sh
# Claude Code — offline default; open_repo can switch local repositories:
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

The default includes offline repository switching but excludes every network tool. Pass a final
comma-separated capability list only to restrict or extend it:

```sh
# Pin the registration to one repository (hide open_repo/list_known_repos):
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> graph,search,source,health,build

# Add network tools while pinning one repository:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> graph,search,source,health,build,online

# Add network tools and keep the default repository switching:
claude mcp add -s user weavatrix -- npx -y weavatrix <repoRoot> graph,search,source,health,build,retarget,online
```

Or clone it:

```sh
git clone https://github.com/sergii-ziborov/weavatrix
cd weavatrix && npm install
claude mcp add -s user weavatrix -- node <path-to>/weavatrix/bin/weavatrix-mcp.mjs <repoRoot>
```

- `<repoRoot>` — the repository to start with; the graph location is derived automatically
  (`<repoRoot-parent>/weavatrix-graphs/<repoName>/graph.json`). Pass an explicit
  `<graph.json> <repoRoot>` pair instead if you keep graphs elsewhere.

No graph yet? Ask the agent to call `rebuild_graph`; it builds the missing graph locally.
`open_repo` can change the active repository and builds a missing graph automatically. A normal
`open_repo` call also upgrades graphs created before `0.1.4` to edge metadata v2; `build:false`
probes without building and refuses a legacy graph. Retargeting is offline but intentionally changes
the filesystem boundary for subsequent tools; omit `retarget` from an explicit capability list when
a registration must stay pinned to one repository.

An agent skill with recipes ships in [skill/SKILL.md](skill/SKILL.md) — install as
`~/.claude/skills/weavatrix/SKILL.md`.

## Tools

**graph** — `graph_stats`, `get_node`, `get_neighbors`, `query_graph`, `god_nodes`,
`shortest_path`, `get_community`, `list_communities`, `module_map`, `get_dependents`,
`change_impact`, `graph_diff`. Runtime dependencies, TypeScript type-only coupling and language
compile-only edges (Rust module/use, Java imports) are reported separately where that distinction
changes the result.

**search / source** — `search_code` (ripgrep-backed, pure-Node fallback), `read_source` (a
symbol's actual code in one hop), `list_endpoints` (HTTP route inventory:
Express/Fastify/Nest/Flask/FastAPI/Go mux/Rust axum and actix-web …)

**health** — `run_audit` (dead code, unused exports, missing/unused npm/Go/Python deps, runtime
cycles, type-only/compile-only coupling, orphans, boundary rules, offline OSV vulnerabilities + typosquat +
lockfile drift), `find_duplicates` (MOSS winnowing over method bodies — catches copy-paste even
after renames), `coverage_map` (existing coverage reports mapped onto the graph; untested hotspots
ranked by connectivity — tests are never executed)

**build** — `rebuild_graph` (reports the structural delta, keeps the prior state as
`graph.prev.json`)

**retarget** *(enabled by default, offline, explicit tool call)* — `open_repo`, `list_known_repos`;
changes the active repository boundary

**online** *(explicit opt-in — see Privacy)* — `refresh_advisories`, `sync_graph`

Quality of life: graph tools self-report staleness vs the repo HEAD; ambiguous name lookups are
disclosed instead of silently guessed; and the server **hot-reloads its watched MCP tool entry
modules and catalog** when those files change — other MCP helpers and analysis engines require a
reconnect.

## Signal quality and repository configuration

Weavatrix `0.1.4` reduces the most common sources of static-analysis noise while deepening Rust and
Java graphs:

- In Git repositories, graph and clone scans use tracked plus non-ignored untracked files, so
  `.gitignore`-excluded build outputs such as packaged applications do not dominate findings.
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
is `graph,search,source,health,build,retarget`: no Weavatrix HTTP requests. `open_repo` changes the
active local boundary only when called. Weavatrix itself initiates outbound HTTP only from two
tools; both require the explicit `online` group and a tool call:

- `refresh_advisories` — queries [OSV.dev](https://osv.dev) with your lockfile's package
  **names + versions** (that is what an OSV query is; never source code) and caches the advisories
  in `~/.weavatrix/advisories.json`. `run_audit` then matches against that store fully offline.
- `sync_graph` — constructs a versioned, allowlisted payload from `graph.json`: relative paths,
  symbol names and line ranges, import/dependency identifiers, edges and numeric metrics. Unknown
  fields are discarded; source file bodies are never read for sync or included in the payload. The
  endpoint is **yours**, configured via `WEAVATRIX_SYNC_URL` / `WEAVATRIX_SYNC_TOKEN`. Off by default.
  Sync payload v2 preserves type-only and compile-only edge metadata. Graphs built before `0.1.4` must be rebuilt
  once before syncing; a normal `open_repo` call performs that upgrade automatically.

If `refresh_advisories` is not listed by the MCP client, that is the expected default: the
registration does not include `online`. Only with the user's approval, add `online` to the final
capability list (for example `graph,search,source,health,build,retarget,online`), restart/reconnect
the MCP server, and then invoke `refresh_advisories`. Enabling the group does not trigger a request
by itself.

Capability groups (`graph`, `search`, `source`, `health`, `build`, `retarget`, `online`) are
selectable through the final positional argument. Omitted caps use the safe default above; an
explicit list exposes exactly the named groups.

## Security model

Socket capability alerts describe expected powers of a local code-analysis tool; they are not
vulnerability findings. This is where each capability comes from and how it is controlled:

| Capability alert | Why it exists | Activation and boundary |
|---|---|---|
| Network access | `refresh_advisories` sends pinned package names and versions to OSV; `sync_graph` sends a versioned allowlist of graph metadata (relative paths, symbols and line ranges, import/dependency identifiers, edges and numeric metrics). It discards unknown graph fields and does not read source file bodies | `online` is disabled by default; each request requires a tool call, and sync additionally requires `WEAVATRIX_SYNC_URL` |
| Shell access | Local `git` powers staleness/change impact; `rg` accelerates search; timed-out Windows child processes may be terminated | Used only by the corresponding local operation; it does not imply network access |
| Debug / dynamic loading | Cache-busted `import()` hot-reloads watched MCP tool entry modules; `createRequire` loads package metadata and parser dependencies | Loads files from the installed package; no `eval` |
| Environment access | Reads `WEAVATRIX_*` configuration; local child processes inherit the normal host environment | `WEAVATRIX_SYNC_TOKEN` is removed from every child-process and worker environment and read only by `sync_graph` |
| Filesystem access | Reads the active repository, graph, lockfiles and coverage reports; writes derived graphs and advisory cache | Realpath containment blocks traversal and symlink/junction escapes. `open_repo` is an explicit offline call that changes the active boundary; omit `retarget` in a custom capability list to pin one repository. The optional malware dependency scan may inspect installed dependency caches such as GOPATH |
| URL strings | Fixed OSV/documentation URLs plus a user-configured sync URL | A URL string causes no request by itself; only the two `online` tools perform requests |

`read_source` accepts repo-relative regular files only, caps a read at 2 MB, and refuses lexical or
realpath escapes. Graph-derived paths pass through the same boundary before analysis tools read
them. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Languages

JavaScript · TypeScript · TSX · Python · Go · Java · C# · Rust · HTML · CSS — parsed with
[web-tree-sitter](https://github.com/tree-sitter/tree-sitter) WASM grammars; no Python install, no
native compilation.

## On-disk layout

Graphs are derived data and never live inside your repo: they go to a `weavatrix-graphs/` folder
**next to** it (one folder per repo, holding `graph.json` + `graph.prev.json`).

## Development

```sh
npm install
npm test          # node --test
```

Design rule: **no source file exceeds 300 lines.** Larger concerns split into dotted-suffix modules
behind a slim facade (`foo.js` re-exports `foo.parse.js`, `foo.report.js`, …); the MCP layer lives
in `src/mcp/` (graph context, tool entry modules, focused helpers, and the catalog/hot-reload
loader) behind the thin stdio entry `src/mcp-server.mjs`.

## Roadmap

- **Hosted graph view** on [weavatrix.com](https://weavatrix.com) — sync with one tool call, share
  the interactive map with your team
- **Graph-anchored memory** — agent notes pinned to nodes/modules, staleness-tracked as the code
  under them changes
- **CI blast radius** — `change_impact` as a PR comment

## License

[MIT](LICENSE) © 2026 Sergii Ziborov
