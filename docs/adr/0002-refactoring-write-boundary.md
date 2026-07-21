# ADR 0002: Refactoring capability and the source-write boundary

Status: proposed

Date: 2026-07-21

## Decision

Weavatrix gains first-class refactoring operations, split along one hard line:
**the core computes and proves; a separately installed package writes.**

The MIT `weavatrix` core stays read-only over repository source, permanently.
It gains read-only planning tools — `rename_symbol`, `move_symbol`/`move_file`,
`delete_readiness`, `change_signature` previews and `post_refactor_verify` —
that emit a `weavatrix.edit-plan.v1` envelope: exact ranges with mandatory
`before` text, a sha256 per target file, per-edit provenance
(`EXACT_LSP`/`RESOLVED`/`EXTRACTED` only), honest `uncertainReferences` and
`notModified` labels, and a single-use `confirm_token` (5-minute TTL, stored
outside the repository — the architecture-bootstrap pattern).

Applying plans is owned by the new Apache-2.0 `weavatrix-refactor` package. It
extends the core through the supported extension API exactly as
`weavatrix-online` does — one server process, one graph, its `refactor` profile
adds the `edit` capability that no core profile can name. Its `apply_edit_plan`
tool re-verifies every hash and every `before` text, writes a rollback bundle
first, applies bottom-up and atomically, and fails closed as `STALE` or
`ROLLED_BACK` — never a silent partial apply. Writing requires all three gates:
the package installed with its profile selected, `WEAVATRIX_ALLOW_SOURCE_EDITS=1`,
and a valid plan-bound token.

`plan_refactor` (multi-move planning, intent assistance, split suggestions) is
a `weavatrix-online` capability. Its plans use the same envelope, so
`weavatrix-refactor` applies them unchanged.

## What this reverses

The v0.2.5 development plan stated "symbol rename is editor behavior" and kept
refactoring out of scope. This ADR narrows that stance rather than discarding
it: *applying* a rename remains out of scope **for this package** — forever and
now verifiably. What enters scope is what the graph, the LSP overlay, and the
evidence model are uniquely good at: computing a rename/move/delete/signature
plan with proof, and verifying the result. The editor role moves to a package
whose name announces it.

## Why a separate package is the safety mechanism

Installing `weavatrix` alone leaves a server that is physically incapable of
modifying source: the artifact contains no source-write paths. Installing
`weavatrix-refactor` is the explicit, visible consent step — the package name
is the informed-consent label. This mirrors ADR 0001: the offline core
contains no fetch paths; the write-capable component is a separate artifact
with its own license (Apache-2.0 for its explicit warranty/liability terms and
patent grant) and its own trust story.

## Release gates

1. A new core release gate proves the npm/MCPB artifact contains no
   source-write path (mirror of the ADR 0001 no-fetch gate): no `writeFileSync`
   or equivalent targeting repository-root-contained paths outside the
   `.weavatrix/architecture.json` create-only bootstrap exception.
2. `weavatrix` and `weavatrix-refactor` release as a compatible pair; the
   `weavatrix.edit-plan.v1` schema is frozen — changes require a
   `schemaVersion` bump and a paired release.
3. Preview tools follow the existing honesty conventions: `completeness`
   statuses, `PARTIAL` never presented as complete, `uncertainReferences`
   never silently dropped, and no plan ever contains an `INFERRED` edit.

## Consequences

- The core tool catalog grows by read-only tools only; `pinned`/`offline`
  profiles never gain a write capability.
- The rename/move planners depend on the bundled TypeScript language server;
  non-LSP languages return graph-evidence inventories labeled `NOT_SUPPORTED`
  for planning, never speculative edits.
- Serena-parity positioning: the atomicity Serena offers lives in
  `apply_edit_plan`; the evidence, blast radius, cycle/architecture dry-run
  and post-apply proof remain capabilities no editor-style rename has.
