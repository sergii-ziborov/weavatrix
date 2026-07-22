// Public export surface for the refactoring plan-producer engines. The engine code lives in
// the core repo because it needs core internals (the graph, the bundled LSP client, the
// tree-sitter grammars, the architecture verifier), but the core MCP catalog does NOT
// register any of it: refactoring is owned by the separate weavatrix-refactor package, which
// imports these builders and registers them as its own tools. Installing the core alone gives
// pure read-only analysis and no refactoring surface; refactoring requires weavatrix-refactor.
// Every builder is a pure/read-only plan producer that emits a weavatrix.edit-plan.v1 (or a
// verdict/review object) — none of them write repository source.

export {buildRenamePlan} from './precision/rename-plan.js'
export {buildRelatedRenamePlan} from './precision/related-rename-plan.js'
export {buildGraphRenamePlan} from './analysis/graph-rename-plan.js'
export {buildSqlRenamePlan} from './analysis/sql-rename-plan.js'
export {buildMoveFilePlan, simulateFileMove} from './analysis/move-file-plan.js'
export {buildMoveSymbolDryRun} from './analysis/move-symbol-dryrun.js'
export {computeDeleteReadiness} from './analysis/delete-readiness.js'
export {buildSymbolEditPlan, SYMBOL_EDIT_OPERATIONS} from './analysis/symbol-edit-plan.js'
export {buildChangeSignaturePlan} from './analysis/change-signature-plan.js'
export {buildBulkReplacePlan} from './analysis/bulk-replace-plan.js'
export {buildOrganizeImportsPlan} from './analysis/organize-imports-plan.js'
export {verifyRefactorConservation} from './analysis/refactor-conservation.js'
