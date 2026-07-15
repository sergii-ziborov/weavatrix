# Weavatrix

**Code graph & blast-radius MCP server for AI coding agents.**

Grep sees text. Weavatrix sees structure. It builds a dependency graph of any local repository —
files, symbols, and the imports/calls/inheritance connecting them — and serves it to Claude Code,
Codex, or any MCP client: change impact, transitive dependents, health audit, clone detection,
coverage mapping. **23 tools. One server for every repo on your machine. Local-first: your code
never leaves it.**

- Website: [weavatrix.com](https://weavatrix.com)
- Status: **pre-release** — npm publish imminent; API may still shift before v0.1.

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

Requires Node ≥ 18. Until the npm package lands, clone and register the server directly:

```sh
git clone https://github.com/sergii-ziborov/weavatrix
cd weavatrix && npm install

# Claude Code — one user-level registration serves every repo on the machine:
claude mcp add -s user weavatrix -- node <path-to>/weavatrix/bin/weavatrix-mcp.mjs <graph.json> <repoRoot>
```

- `<repoRoot>` — the repository you want to start with.
- `<graph.json>` — where its graph lives (or will be built):
  `<repoRoot-parent>/weavatrix-graphs/<repoName>/graph.json`.

No graph yet? Just ask the agent to call `open_repo` — it builds missing graphs itself. From then
on, `open_repo` retargets the same running server at **any** other local repository; never register
a second copy.

An agent skill with recipes ships in [skill/SKILL.md](skill/SKILL.md) — install as
`~/.claude/skills/weavatrix/SKILL.md`.

## Tools

**graph** — `graph_stats`, `get_node`, `get_neighbors`, `query_graph`, `god_nodes`,
`shortest_path`, `get_community`, `list_communities`, `module_map`, `get_dependents`,
`change_impact`, `graph_diff`, `list_known_repos`

**search / source** — `search_code` (ripgrep-backed, pure-Node fallback), `read_source` (a
symbol's actual code in one hop), `list_endpoints` (HTTP route inventory:
Express/Fastify/Nest/Flask/FastAPI/Go mux …)

**health** — `run_audit` (dead code, unused exports, missing/unused npm/Go/Python deps, import
cycles, orphans, boundary rules, offline OSV vulnerabilities + typosquat + lockfile drift),
`find_duplicates` (MOSS winnowing over method bodies — catches copy-paste even after renames),
`coverage_map` (existing coverage reports mapped onto the graph; untested hotspots ranked by
connectivity — tests are never executed)

**build** — `rebuild_graph` (reports the structural delta, keeps the prior state as
`graph.prev.json`), `open_repo`

**online** *(explicit opt-in — see Privacy)* — `refresh_advisories`, `sync_graph`

Quality of life: graph tools self-report staleness vs the repo HEAD; ambiguous name lookups are
disclosed instead of silently guessed; and the server **hot-reloads its own tool code** when the
files under `src/mcp/` change — no reconnect needed.

## Privacy: local-first, offline by design

Graph queries, audits and clone scans run in-process against local files. Exactly two tools can
touch the network, both in the `online` capability group and both inert until explicitly invoked:

- `refresh_advisories` — queries [OSV.dev](https://osv.dev) with your lockfile's package
  **names + versions** (that is what an OSV query is; never source code) and caches the advisories
  in `~/.weavatrix/advisories.json`. `run_audit` then matches against that store fully offline.
- `sync_graph` — pushes `graph.json` (file paths, symbol names, edges — never file contents) to an
  endpoint **you** configure via `WEAVATRIX_SYNC_URL` / `WEAVATRIX_SYNC_TOKEN`. Off by default.

Capability groups (`graph`, `search`, `source`, `health`, `build`, `online`) are selectable per
registration via a fifth argument — a comma-separated list. Omit `online` from it and those tools
don't exist for that client.

## Languages

JavaScript · TypeScript · TSX · Python · Go · Java · HTML · CSS — parsed with
[web-tree-sitter](https://github.com/tree-sitter/tree-sitter) WASM grammars; no Python install, no
native compilation. Rust is on the roadmap.

## On-disk layout

Graphs are derived data and never live inside your repo: they go to a `weavatrix-graphs/` folder
**next to** it (one folder per repo, holding `graph.json` + `graph.prev.json`).

## Development

```sh
npm install
npm test          # node --test — 224 tests
```

Design rule: **no source file exceeds 300 lines.** Larger concerns split into dotted-suffix modules
behind a slim facade (`foo.js` re-exports `foo.parse.js`, `foo.report.js`, …); the MCP layer lives
in `src/mcp/` (graph context, four tool modules, catalog + hot-reload loader) behind the thin stdio
entry `src/mcp-server.mjs`.

## Roadmap

- **npm package** (`npx weavatrix-mcp`) — imminent
- **Hosted graph view** on [weavatrix.com](https://weavatrix.com) — sync with one tool call, share
  the interactive map with your team
- **Graph-anchored memory** — agent notes pinned to nodes/modules, staleness-tracked as the code
  under them changes
- **CI blast radius** — `change_impact` as a PR comment
- **Rust** grammar support

## License

[MIT](LICENSE) © 2026 Sergii Ziborov
