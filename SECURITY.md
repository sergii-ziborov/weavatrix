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
as GOPATH. The default `retarget` capability exposes `open_repo`, an explicit offline tool call that
intentionally changes the active repository; omit that group in a custom capability list to pin one
boundary. The optional `online` capability contains Weavatrix's HTTP tools; `sync_graph`
additionally requires a user-configured endpoint and sends only a versioned metadata allowlist,
discarding unknown fields from the local graph cache.
