# Security Policy

## Supported versions

Security fixes are provided for the latest published version of Weavatrix. Upgrade to the newest
release before reporting an issue that may already be resolved.

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

The default MCP registration is offline. Every standard source, manifest, configuration and coverage
read is canonical-path-contained within the active repository and rejects traversal plus symlink or
junction escapes. The optional malware dependency scan may inspect installed dependency caches such
as GOPATH. The default capability set pins the startup repository and does not expose `open_repo`;
add the optional `retarget` group only when an operator intentionally wants explicit repository
switching. The optional `online` capability contains Weavatrix's HTTP tools; `sync_graph`
additionally requires a user-configured endpoint. Payload v3 runs bounded local analyzers over the
active repository, then sends only a strict graph/evidence allowlist plus a normalized repository
display name. The contract has no source-body, snippet, absolute-host-path, environment, credential,
Git-remote or analyzer-error fields; unknown fields are discarded and unsafe optional path metadata
is omitted. V3 rejects stale graphs, duplicate node IDs, dangling edges and oversized payloads before
any request. Graph-only payload v2
remains an explicit compatibility option and is never selected as a silent fallback.
