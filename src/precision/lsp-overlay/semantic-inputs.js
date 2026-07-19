import {typeScriptProjectSafety} from '../typescript-lsp-provider.js'
import {JS_TS_FILE, graphMode, graphScope, norm} from './contract.js'

export class PrecisionBudgetError extends Error {
  constructor(message = 'semantic precision deadline reached') {
    super(message)
    this.name = 'PrecisionBudgetError'
  }
}

export class PrecisionLimitError extends Error {
  constructor(message) { super(message); this.name = 'PrecisionLimitError' }
}

export class PrecisionStaleGraphError extends Error {
  constructor() {
    super('repository content did not match the graph snapshot')
    this.name = 'PrecisionStaleGraphError'
  }
}

export class PrecisionStaleSemanticInputsError extends Error {
  constructor() {
    super('TypeScript project inputs changed while semantic precision was running')
    this.name = 'PrecisionStaleSemanticInputsError'
  }
}

export function graphJavaScriptUniverse(graph) {
  const files = [...new Set((graph.nodes || []).filter((node) => {
    const id = String(node?.id || '')
    const file = norm(node?.source_file || id)
    return id === file && JS_TS_FILE.test(file)
  }).map((node) => norm(node.source_file || node.id)))].sort()
  const hashed = Object.keys(graph.fileHashes || {}).map(norm).filter((file) => JS_TS_FILE.test(file)).sort()
  const fileSet = new Set(files)
  const complete = graphMode(graph) === 'full' && !graphScope(graph)
    && files.length === hashed.length && hashed.every((file) => fileSet.has(file))
  return {files, complete}
}

export function precisionSemanticInputs(repoRoot, graph, options = {}) {
  const universe = graphJavaScriptUniverse(graph)
  if (!universe.files.length) {
    return {safe: false, reason: 'NO_JAVASCRIPT_TYPESCRIPT_INPUTS', fingerprint: null, universe}
  }
  return {...typeScriptProjectSafety(repoRoot, universe.files, options), universe}
}

export function precisionSemanticInputsMatch(overlay, repoRoot, graph) {
  const current = precisionSemanticInputs(repoRoot, graph)
  return current.safe === true
    && typeof current.fingerprint === 'string'
    && current.fingerprint.length > 0
    && String(overlay?.semanticInputFingerprint || '') === current.fingerprint
}

export function publicSemanticSafetyReason(reason) {
  return reason === 'CONFIGURED_TSSERVER_PLUGINS'
    ? 'configured TypeScript language-service plugins are not allowed'
    : 'TypeScript project configuration could not be verified safely'
}
