// Infrastructure / backing-service detection. graph-builder's graph.json only contains code FILES and
// symbols, so the GUI board's external-service towers were inferred purely from FILE PATHS
// (relIsDb + a name-regex). That misses any datastore whose connector file isn't literally named
// after it — e.g. a service that `import`s @clickhouse/client from services/metrics.js, or wires
// Influx through a logging helper. This module reads the REAL high-signal sources instead:
//   1. dependency manifests   (package.json / go.mod / requirements.txt / pom.xml / build.gradle /
//                              Cargo.toml / *.csproj / Gemfile / composer.json)  — most reliable
//   2. container/orchestration (docker-compose / Dockerfile / k8s manifests) — image names
//   3. env / config            (.env*, k8s env:) — variable-NAME conventions (KEYS ONLY, never values)
//   4. source imports          — to attribute each service to its connector file(s) for the io edges
// and matches them against a curated signature registry → a structured list of services the repo
// talks to, each with kind/name/colour + the files that connect to it.
//
// PRIVACY: env files are read for KEY NAMES only (the part before `=`); values are never parsed,
// stored, logged, or returned. Secrets in .env stay in .env.
//
// This file is now a facade — the implementation lives in the sibling modules below; every public
// export is re-exported here so existing import paths keep working unchanged:
//   infra.match.js  — deterministic matchers (deps / images / env keys) + manifest dep extraction
//   infra.scan.js   — the single filesystem walk (manifests, compose/k8s images, env KEY names)
//   infra.detect.js — signature matching, connector-file attribution, cached public API

// ---- signature registry ----
// One row per backing service, loaded from infra-registry.js (generated + adversarially verified by the
// infra-signature-registry workflow). Matching is DETERMINISTIC token comparison (no free-form regex over
// arbitrary text), so false positives stay near zero:
//   deps        — exact manifest dependency names; token T matches dep D when D===T or D starts with T/ T: T@.
//   images      — docker image repo names, matched by path-segment SUFFIX ("redis" hits "bitnami/redis";
//                 "mongo" misses "mongo-express").
//   envPrefixes — UPPERCASE env-var KEY prefixes; token P matches key K when K===P or K starts with P_.
//                 Prefixes listed in envWeak only count when the key ALSO ends in an infra suffix
//                 (HOST/URL/DSN/PORT/BROKER/…), so DATABASE_URL-style keys can't over-fire.
//   imports     — quoted substrings in source import/require lines; used to attribute connector files.
// kind ∈ db|ts|cache|queue|cloud|api|fs|logs — drives the GUI board tower glyph/colour (GUI core KCFG).
export { INFRA_SERVICES } from "./infra-registry.js";

export { depMatches, normImageRepo, imageMatches, envMatches, depsFromManifest } from "./infra.match.js";
export { detectInfraFromScan, detectInfra } from "./infra.detect.js";
