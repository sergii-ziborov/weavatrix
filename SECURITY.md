# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `0.2.15.x` | Yes |
| `0.2.14` and older | Upgrade to the latest release |

Security fixes are provided for the latest published version of Weavatrix. Upgrade before reporting
an issue that may already be resolved.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting flow:

https://github.com/sergii-ziborov/weavatrix/security/advisories/new

Include the affected Weavatrix version, operating system, MCP client, enabled capability groups,
reproduction steps, expected boundary, observed behavior, and potential impact. Avoid including real
credentials, private source code, or other sensitive data in the report.

Reports will be investigated privately. Public disclosure should be coordinated after a fix or
mitigation is available so users have a reasonable opportunity to update.

## Security boundaries

The default `offline` MCP profile exposes no HTTP tools. Every standard source, manifest,
configuration and coverage read is canonical-path-contained within the active repository and rejects
traversal plus symlink or junction escapes. The optional malware dependency scan may inspect installed
dependency caches such as GOPATH. `offline` permits repository switching only through an explicit
local `open_repo` call; select `pinned` to remove that tool, the global repository listing, and
cross-repository API tracing, holding a hard startup-repository boundary.

Installed-package malware pattern matching is static heuristic evidence. It cannot confirm execution,
package compromise, or credential exposure and therefore cannot emit `critical`; heuristic severity
is capped at `high` with explicit `NOT_VERIFIED` runtime/origin/lockfile/exposure fields. Independently
confirmed malicious-package advisories remain separate vulnerability evidence and may be critical.

The JS/TS precision overlay is enabled by default for new graphs and runs the package-pinned `typescript-language-server` and
TypeScript runtime as local child processes. It never resolves a repository executable, invokes
`npx`, runs package scripts, or installs dependencies. Automatic type acquisition is disabled, and
the provider receives an allowlisted OS/temp/locale environment with a constrained executable path;
registry, proxy, cloud, token and `NODE_OPTIONS` values are excluded. The provider makes no
Weavatrix HTTP request and Weavatrix transmits no source or evidence. TypeScript may still read
locally declared project configuration, dependencies and type declarations; returned evidence is
accepted only after repository realpath containment. Before spawning the provider, Weavatrix parses
the applicable repo-contained TypeScript/JavaScript config chains with its bundled TypeScript API and
refuses semantic mode when a configured language-service plugin, unresolved/outside config, or input
safety limit is encountered. Config and configured-project inputs are fingerprinted and rechecked
before cached evidence is used and after each provider run.
This is an application/process boundary rather than an operating-system
network sandbox. On stdio EOF, SIGTERM or SIGINT, the MCP server stops new providers, performs a
bounded graph-work drain, and closes or tree-terminates TLS/tsserver before exiting.
Set `WEAVATRIX_PRECISION=off` before server startup (or select `off` in the MCPB semantic-precision
setting) to keep new graphs parser-only from their first build.

`verified_change` is read-only by default. Its optional targeted-test step can execute only an
existing `package.json` script whose name matches the bounded test/check/verify allowlist. The call
must set `run_tests:true` and the server operator must separately set
`WEAVATRIX_ALLOW_TEST_RUNS=1`; otherwise no repository script runs. The tool accepts no command or
shell string, caps scripts/arguments/time, rejects shell-sensitive argument characters, and launches
the selected package-manager script with the credential-stripped child environment. Repository test
scripts are repository-controlled code and may have arbitrary side effects, so enable this flag only
for repositories and scripts you trust.

Network capabilities are split by purpose. `osv` adds only `refresh_advisories`, which sends pinned
package names and versions to OSV.dev when called. `hosted` / `full` also expose the local-only
`preview_sync` plus networked `sync_graph` and `pull_architecture_contract`; the network tools require
a user-configured endpoint, and contract pull requires bearer authentication. The legacy `online`
capability remains an alias for advisory plus hosted networking so existing registrations do not break.

`preview_sync` is the first half of a two-step consent boundary. It constructs the strict allowlisted
payload locally but has no network path. It displays the configured hostname/path, normalized
repository name, opaque repository UUID, payload version, included sections, node/link/byte counts
and canonical SHA-256 hash. Sending requires `sync_graph` with both `dry_run:false` and the exact
confirmation token for that cached payload and destination; the token
expires after five minutes and is stored only in process memory. A token with the default dry-run,
or an incorrect/expired token, does not send. Sync rejects
embedded URL credentials and fragments and requires HTTPS except for explicit loopback development
endpoints. Query parameters may be used by a configured endpoint but are not echoed in previews or
errors.

Every MCP response includes transient local `_meta["weavatrix/metrics"]` timing, output-size/token
estimate, graph freshness/revision/update and graph-cache status. Weavatrix does not persist, aggregate
or transmit these measurements; they are response evidence for the caller, not product telemetry.

Payload v3 runs bounded local analyzers over the active repository, then sends only a strict
graph/evidence allowlist plus a normalized repository display name. That evidence can include a
bounded direct/transitive lockfile dependency graph and stable clone/divergence candidates. The
contract has no source-body,
snippet, absolute-host-path, environment, credential, Git-remote or analyzer-error fields; unknown
fields are discarded and unsafe optional path metadata is omitted. V3 rejects stale graphs,
duplicate node IDs, dangling edges and oversized payloads before any request. Graph-only payload v2
remains an explicit compatibility option and is never selected as a silent fallback.

`pull_architecture_contract` sends only the active repository's opaque stable UUID, receives an
owner-approved target contract, validates it, and caches it locally. It never sends source, symbols,
file paths, or Git metadata. It applies the same HTTPS-outside-loopback and embedded-credential URL
rules before sending bearer authentication. Authentication, forbidden, not-found and repository-not-ready responses
are reported as distinct states so a missing registration or contract is not presented as an opaque
HTTP failure.
