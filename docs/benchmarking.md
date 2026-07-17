# Public 0.2.2 benchmark foundation

The benchmark is a permanent, source-controlled regression gate for the graph builder and MCP
lifecycle. It is intentionally small enough to run locally and contains no network calls or new
runtime dependency.

## Commands

```sh
npm run benchmark:quick  # correctness, graph/report bytes and cold build budgets
npm run benchmark        # quick gates plus real MCP freshness/reconnect checks
npm run benchmark:real   # available real repositories against the 0.2.1 baseline
npm run benchmark:real:release  # require all six real repositories
```

Both commands print a source-free `weavatrix.benchmark.v1` JSON report and exit non-zero when a
gate fails. Pass `-- --output <path>` to write the same report to a file. Generated reports are not
committed because latency and environment metadata are machine-specific.

The quick benchmark also runs in `npm test`. Before a release, run the full command separately so
the actual stdio server lifecycle is exercised without competing test-process load.

The real-repository command is portable: `benchmark/real-repositories.json` contains only labels,
language expectations, environment-variable names and relative path hints. It never commits an
absolute machine path. A normal run reports an unavailable private checkout as `MISSING` and exits
successfully with overall `PARTIAL`; the release command treats anything except complete `PASS` as
a failure.

## Permanent corpus

`benchmark/fixtures/` contains minimal, deterministic repositories for:

- TypeScript, including NodeNext `.js` import specifiers resolving to TypeScript sources;
- JavaScript, Python and Go import/call relationships;
- Java type declarations, class inheritance, interface implementation, type references and method
  ownership;
- Rust `mod`/`use` compile-time relationships and an axum endpoint;
- a separate frontend/backend pair with a generic TypeScript HTTP wrapper, handler resolution,
  affected-screen tracing and `NOT_DEAD_EXTERNAL_USE` liveness.
- a framework/convention repository covering a Next route, Next/React and Vinext/Vite/Cloudflare
  peer contracts, Sass compiler input, a resource worker entered by convention, and generated/e2e
  noise suppression. An unused control dependency ensures the fixture cannot pass by suppressing
  every unused-dependency finding.

The corpus checks representative signals, not universal language or framework recall. A passing
Java or Rust fixture means the listed behavior did not regress; it does not claim compiler-exact
coverage for arbitrary projects.

## Gates and semantics

Budgets live in `benchmark/cases.mjs` and are reported with every run:

- each graph is at most 128 KiB;
- each cold fixture build is at most 15 seconds and all cold builds total at most 60 seconds;
- the report and concise text response are each at most 64 KiB;
- reconnect completes within 10 seconds (including cold Windows/WASM startup variance);
- freshness follows `full -> incremental -> none -> reconnect/none`;
- the repository target and graph revision stay stable across reconnect.
- every edge is classified by provenance with no `UNKNOWN` entries.

Edge provenance is a separate, versioned contract from legacy confidence:

- `EXACT_LSP` is emitted only by the bundled, bounded TypeScript/JavaScript language-server overlay;
- `EXTRACTED` comes directly from parsed syntax or ownership structure;
- `RESOLVED` means an extracted reference/import was resolved to a repository target;
- `INFERRED` is a conservative static relationship such as a name-resolved call;
- `CONFLICT` is reserved for disagreeing evidence that must not be silently collapsed.

The static builder emits the middle three kinds. The revision-bound 0.2.4 precision sidecar can
enrich individual TS/JS references with `EXACT_LSP` without changing static graph identity or
replacing repo-wide analysis; `CONFLICT` remains reserved for explicitly disagreeing evidence.

Correctness and byte gates are deterministic release blockers. Latency gates use deliberately broad
ceilings and should be compared on the same class of machine; a failure still requires inspection
rather than automatically increasing a budget.

## Remaining 0.2.2 coverage

The manifest-driven runner has source-free 0.2.1 baselines for `frontend`, `analytics`,
`automation`, `bgp-speaker` and `warroom`. Each record contains only a Git revision, structural
fingerprint, counts and timings. The current runner rejects unexplained relation drops above 5%,
reports a stale source revision separately from a builder regression, requires complete edge
provenance, and caps its report at 64 KiB. Java also gates representative symbol kinds, OOP
relations and endpoints. Rust gates module/import relations and endpoints when its source exists.

`AI-Dev-System` remains explicitly `MISSING` because this machine currently has derived graph files
but no Rust source checkout. Set `WEAVATRIX_BENCHMARK_AI_DEV_SYSTEM` to its source directory and
regenerate the 0.2.1 baseline before calling the six-repository release gate complete. The other
checkout variables follow the same `WEAVATRIX_BENCHMARK_<NAME>` pattern documented in the manifest.

Framework peer/build-tool and convention-consumer fixtures and edge-provenance gates are part of
the permanent quick gate. The real report exposes `gaps.java` and `gaps.rust`; on this machine Java
is empty and Rust contains `SOURCE_CHECKOUT_MISSING`, so the six-repository release command remains
correctly red rather than manufacturing a green result from derived graph files.
