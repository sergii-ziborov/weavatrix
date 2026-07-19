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

The 0.3 MIT artifact contains no HTTP tool, sync endpoint/token setting, remote advisory refresher or
compatibility alias that can enable one. `offline` and `pinned` are both network-free. Advisory
matching reads only a local validated cache; a missing or stale cache remains `NOT_CHECKED` or
`PARTIAL`, never a clean zero.

The public extension API allows a dependent package to add MCP tools, packaged skills and local
audit providers. Extension tools cannot replace a core tool, extension profiles cannot replace a
core profile, and audit providers must declare `network:"none"`; failures remain explicit
`ERROR/PARTIAL`. The separate `weavatrix-online` superset owns endpoint policy, consent,
authentication, capability negotiation and every outbound request.

Every MCP response includes transient local `_meta["weavatrix/metrics"]` timing, output-size/token
estimate, graph freshness/revision/update and graph-cache status. Weavatrix does not persist, aggregate
or transmit these measurements; they are response evidence for the caller, not product telemetry.

Core exposes local-only services that build and validate the bounded source-free payload, validate
connector-provided advisory records, create opaque repository identity and cache a validated
architecture contract. These services read no connector credential and perform no network I/O.
