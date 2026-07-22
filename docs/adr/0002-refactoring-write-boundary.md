# ADR 0002: Refactoring capability and the source-write boundary

Status: accepted

Date: 2026-07-21

## Decision

Weavatrix has first-class refactoring operations split along one hard line:
**the core computes analysis; a separately installed package writes.**

The MIT `weavatrix` core remains permanently read-only over repository source.
It exports the supported read-only analysis surface used by the separately
installed Apache-2.0 `weavatrix-refactor` package. The refactor package owns
`rename_symbol`, `rename_related_symbols`, the other plan producers, and the
generic apply and rollback tools.

Applyable operations use a `weavatrix.edit-plan.v1` envelope: exact ranges with
mandatory `before` text, a sha256 per target file, per-edit provenance
(`EXACT_LSP`, `RESOLVED`, `EXTRACTED`, or `LEXICAL_EXACT`), honest
`uncertainReferences`, and `notModified` labels. No `INFERRED` edit is applyable.

`rename_symbol` and `rename_related_symbols` own a complete two-call workflow.
The default `mode="preview"` verifies the generated plan and returns `PREVIEW_OK`
plus a short-lived, single-use token. Calling the same method with identical
operation inputs, `mode="apply"`, and that token recomputes the deterministic
plan, re-verifies it, writes a rollback bundle, and applies atomically. The
generic `apply_edit_plan` tool keeps the same preview/confirm/apply contract for
plans produced by other refactor tools or `weavatrix-online`.

Writing requires all three gates: the refactor package/profile with the `edit`
capability, `WEAVATRIX_ALLOW_SOURCE_EDITS=1`, and a valid plan-bound token. The
token fingerprint excludes only generated `createdAt` provenance metadata so a
same-method apply can recompute a plan; all executable fields, including file
hashes, ranges, before/after text, and provenance, remain bound.

`plan_refactor` (multi-move planning, intent assistance, and split suggestions)
is a `weavatrix-online` capability. Its plans use the same envelope and can be
applied by `weavatrix-refactor` unchanged.

## What this reverses

The v0.2.5 development plan stated that symbol rename was editor behavior and
kept refactoring out of scope. Applying a rename remains permanently out of
scope for the core package. The editor role belongs to a package whose name and
selected profile explicitly announce write capability.

## Why a separate package is the safety mechanism

Installing `weavatrix` alone leaves a server physically incapable of modifying
source: the artifact contains no repository source-write path. Installing and
selecting `weavatrix-refactor` is the explicit consent step. This mirrors ADR
0001: the offline core contains no fetch path, while network capability belongs
to a separate artifact.

## Release gates

1. The core release gate proves the npm/MCPB artifact contains no repository
   source-write path outside the create-only architecture bootstrap exception.
2. `weavatrix` and `weavatrix-refactor` release as a compatible pair. Changes to
   `weavatrix.edit-plan.v1` require a schema-version bump and paired release.
3. Refactor tools preserve honesty: `PARTIAL` is never presented as complete,
   `uncertainReferences` are never dropped, and no plan contains an `INFERRED`
   applyable edit.

## Consequences

- Core `pinned` and `offline` profiles never gain a write capability.
- JS/TS rename uses the bundled TypeScript language server, SQL uses the schema
  backend, and Rust/Python/Go/Java/C#/Solidity use strict graph+lexical edits.
  Non-LSP completeness remains `PARTIAL`; ambiguous references are reported and
  never guessed.
- Atomic writes live in the rename workflows and `apply_edit_plan`; evidence,
  blast-radius analysis, architecture checks, and post-apply proof remain
  separate explicit capabilities.
