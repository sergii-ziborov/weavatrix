import {existsSync, readFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {atomicWriteFileSync} from '../../graph/file-lock.js'
import {edgeProvenance} from '../../graph/edge-provenance.js'
import {
  PRECISION_FILE,
  PRECISION_OVERLAY_V,
  baseOverlay,
  endpoint,
  precisionOverlayMatches,
} from './contract.js'

export function precisionPathForGraph(graphPath) {
  return resolve(dirname(graphPath), PRECISION_FILE)
}

export function readPrecisionOverlay(graphPath, graph) {
  const path = precisionPathForGraph(graphPath)
  if (!existsSync(path)) return null
  try {
    const overlay = JSON.parse(readFileSync(path, 'utf8'))
    return precisionOverlayMatches(overlay, graph) ? overlay : null
  } catch { return null }
}

export function precisionSummary(overlay) {
  if (!overlay) return {
    state: 'UNAVAILABLE',
    provider: null,
    verifiedEdges: 0,
    candidates: 0,
    queried: 0,
    reason: 'no revision-matched precision overlay',
  }
  const engine = Array.isArray(overlay.engines) ? overlay.engines[0] : null
  return {
    state: String(overlay.state || 'UNAVAILABLE'),
    provider: engine?.provider || null,
    providerVersion: engine?.version || null,
    typescriptVersion: engine?.typescriptVersion || null,
    verifiedEdges: Number(overlay.coverage?.verifiedEdges) || 0,
    candidates: Number(overlay.coverage?.candidates) || 0,
    selected: Number(overlay.coverage?.selected) || 0,
    queried: Number(overlay.coverage?.queried) || 0,
    references: Number(overlay.coverage?.references) || 0,
    unclassifiedReferences: Number(overlay.coverage?.unclassifiedReferences) || 0,
    referenceEvidence: Array.isArray(overlay.referenceEvidence) ? overlay.referenceEvidence.length : 0,
    truncated: overlay.coverage?.truncated === true,
    reason: overlay.reason || engine?.reason || null,
    noReferenceSymbols: Array.isArray(overlay.noReferenceSymbols) ? overlay.noReferenceSymbols.length : 0,
  }
}

export function mergePrecisionOverlay(graph, overlay) {
  if (!precisionOverlayMatches(overlay, graph)) return {...graph, precision: precisionSummary(null)}
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const ids = new Set(nodes.map((node) => String(node.id)))
  const links = (Array.isArray(graph.links) ? graph.links : []).map((link) => ({...link}))
  for (const exact of Array.isArray(overlay.links) ? overlay.links : []) {
    const source = endpoint(exact.source)
    const target = endpoint(exact.target)
    if (!ids.has(source) || !ids.has(target) || source === target) continue
    const relation = String(exact.relation || 'references')
    const exactLine = Number.isInteger(exact.line) ? exact.line : null
    const exactCharacter = Number.isInteger(exact.character) ? exact.character : null
    let matched = false
    for (const link of links) {
      if (edgeProvenance(link) !== 'EXACT_LSP') continue
      if (endpoint(link.source) !== source || endpoint(link.target) !== target
        || String(link.relation || '') !== relation) continue
      if (exactLine != null && (!Number.isInteger(link.line) || link.line !== exactLine)) continue
      if (exactCharacter != null
        && (!Number.isInteger(link.character) || link.character !== exactCharacter)) continue
      link.provenance = 'EXACT_LSP'
      link.confidence = 'EXACT_LSP'
      link.precisionProvider = String(exact.provider || 'typescript-language-server')
      if (exact.typeOnly === true) link.typeOnly = true
      else delete link.typeOnly
      if (exact.compileOnly === true) link.compileOnly = true
      else delete link.compileOnly
      matched = true
      break
    }
    if (!matched) links.push({
      source,
      target,
      relation: relation || 'references',
      provenance: 'EXACT_LSP',
      confidence: 'EXACT_LSP',
      precisionProvider: String(exact.provider || 'typescript-language-server'),
      ...(exact.typeOnly === true ? {typeOnly: true} : {}),
      ...(exact.compileOnly === true ? {compileOnly: true} : {}),
      ...(exactLine != null ? {line: exactLine} : {}),
      ...(exactCharacter != null ? {character: exactCharacter} : {}),
      ...(Number.isInteger(exact.endLine) ? {endLine: exact.endLine} : {}),
      ...(Number.isInteger(exact.endCharacter) ? {endCharacter: exact.endCharacter} : {}),
    })
  }
  return {
    ...graph,
    links,
    precisionOverlayV: PRECISION_OVERLAY_V,
    precision: precisionSummary(overlay),
    precisionNoReferenceSymbols: Array.isArray(overlay.noReferenceSymbols)
      ? overlay.noReferenceSymbols.filter((id) => ids.has(String(id))).map(String) : [],
    precisionReferenceEvidence: Array.isArray(overlay.referenceEvidence)
      ? overlay.referenceEvidence.filter((evidence) => ids.has(endpoint(evidence.source))
        && ids.has(endpoint(evidence.target))).map((evidence) => ({
        source: endpoint(evidence.source),
        target: endpoint(evidence.target),
        ...(Number.isInteger(evidence.line) ? {line: evidence.line} : {}),
        ...(Number.isInteger(evidence.character) ? {character: evidence.character} : {}),
        classification: String(evidence.classification || 'unknown'),
        provider: String(evidence.provider || 'typescript-language-server'),
      })) : [],
  }
}

export function writePrecisionOverlay(graphPath, overlay) {
  atomicWriteFileSync(precisionPathForGraph(graphPath), JSON.stringify(overlay), 'utf8')
  return overlay
}

const SAFE_INVALIDATION_REASON = 'repository changed while semantic precision was running'

export function invalidatePrecisionOverlay(graphPath, graph, reason = SAFE_INVALIDATION_REASON) {
  if (!graphPath || !graph) throw new Error('precision invalidation requires graphPath and graph')
  const previous = readPrecisionOverlay(graphPath, graph)
  const safeReason = typeof reason === 'string'
    && reason.length > 0 && reason.length <= 160
    && /^[A-Za-z0-9 _.,()-]+$/.test(reason) ? reason : SAFE_INVALIDATION_REASON
  const engines = (Array.isArray(previous?.engines) && previous.engines.length
    ? previous.engines
    : [{
      provider: 'typescript-language-server', version: null,
      language: 'typescript/javascript', capability: 'textDocument/references',
    }]).map((engine) => ({...engine, status: 'PARTIAL'}))
  return writePrecisionOverlay(graphPath, baseOverlay(graph, 'PARTIAL', {
    ...(previous?.request ? {request: previous.request} : {}),
    reason: safeReason,
    engines,
    coverage: {
      candidates: 0, selected: 0, queried: 0, references: 0,
      unclassifiedReferences: 0, verifiedEdges: 0, truncated: true,
    },
    links: [],
    referenceEvidence: [],
    noReferenceSymbols: [],
  }))
}
