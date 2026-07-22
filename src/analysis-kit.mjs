// Read-only analysis primitives the weavatrix-refactor package composes into refactoring
// plan producers. Everything exported here is PURE READ: graph identity helpers, cycle
// detection, architecture verification, the bundled tree-sitter grammars, the read-only
// TypeScript language-server client, and dead-code risk signals. None of it writes, applies,
// or references applying a change — the core catalog and the release gate keep the core
// provably free of any source-write or edit-plan path. The refactoring engines live in
// weavatrix-refactor and import this surface.

export {graphEndpointId, fileOfId} from './graph/node-id.js'
export {Parser, Query, EXT_LANG, ensureParser} from './graph/internal-builder.langs.js'
export {querySymbolPrecision} from './precision/symbol-query.js'
export {createTypeScriptLspClient} from './precision/typescript-provider/client.js'
export {verifyArchitecture} from './analysis/architecture/contract-verification.js'
export {normalizeArchitectureContract} from './analysis/architecture-contract.js'
export {buildFileImportGraph, findSccs} from './analysis/structure/dependency-graph.js'
export {isFrameworkEntryFile} from './analysis/dead-check.js'
export {hasDynamicCode, REFLECTION_CODE_RE} from './analysis/dead-code-review/policy.js'
