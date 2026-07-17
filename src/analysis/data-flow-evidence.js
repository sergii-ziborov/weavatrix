import {readFileSync} from 'node:fs'
import {extname} from 'node:path'
import ts from 'typescript'
import {createRepoBoundary} from '../repo-path.js'

const lineOfNode = (node) => Number(String(node?.source_location || '').match(/^L(\d+)/i)?.[1] || String(node?.id || '').match(/@(\d+)$/)?.[1] || 0)
const fileOfNode = (node) => String(node?.source_file || String(node?.id || '').split('#')[0]).replace(/\\/g, '/')
const cleanName = (value) => String(value || '').replace(/\(\)$/, '').split('.').pop()
const callName = (node) => node.expression?.name?.text || node.expression?.text || node.expression?.escapedText || ''

function scriptKind(file) {
  const ext = extname(file).toLowerCase()
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.jsx') return ts.ScriptKind.JSX
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function parse(cache, boundary, file) {
  if (cache.has(file)) return cache.get(file)
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return null
  const resolved = boundary.resolve(file)
  if (!resolved.ok) return null
  try {
    const source = ts.createSourceFile(file, readFileSync(resolved.path, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(file))
    cache.set(file, source)
    return source
  } catch { return null }
}

function parametersFor(source, target) {
  const expected = cleanName(target?.label)
  const expectedLine = lineOfNode(target)
  const choices = []
  const visit = (node) => {
    if (Array.isArray(node.parameters) && node.name) {
      const name = cleanName(node.name.text || node.name.getText?.(source))
      if (!expected || name === expected) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        choices.push({line, parameters: node.parameters.map((item) => item.name.getText(source).slice(0, 80))})
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  choices.sort((a, b) => Math.abs(a.line - expectedLine) - Math.abs(b.line - expectedLine))
  return choices[0]?.parameters || []
}

function callsAt(source, line, expectedName) {
  const found = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const at = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      if ((!line || at === line) && (!expectedName || cleanName(callName(node)) === expectedName)) found.push({node, line: at})
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// Bounded interprocedural evidence: maps arguments at graph callsites to the callee's declared
// parameters. This is not a control-flow graph, value propagation, or taint-analysis claim.
export function extractCallArgumentEvidence({graph, repoRoot, seedIds = [], depth = 2, maxEdges = 40} = {}) {
  const boundary = createRepoBoundary(repoRoot)
  const cache = new Map()
  const queue = (seedIds || []).map((id) => ({id: String(id), hop: 0}))
  const visited = new Set()
  const seenCalls = new Set()
  const edges = []
  let unsupported = 0
  while (queue.length && edges.length < maxEdges) {
    const current = queue.shift()
    if (visited.has(current.id) || current.hop >= depth) continue
    visited.add(current.id)
    const calls = [
      ...(graph.out.get(current.id) || []).filter((edge) => edge.relation === 'calls')
        .map((edge) => ({fromId: current.id, toId: String(edge.id), line: Number(edge.line) || 0, nextId: String(edge.id)})),
      ...(graph.inn.get(current.id) || []).filter((edge) => edge.relation === 'calls')
        .map((edge) => ({fromId: String(edge.id), toId: current.id, line: Number(edge.line) || 0, nextId: String(edge.id)})),
    ]
    for (const callEdge of calls) {
      const callKey = `${callEdge.fromId}\0${callEdge.toId}\0${callEdge.line}`
      if (seenCalls.has(callKey)) continue
      seenCalls.add(callKey)
      const from = graph.byId.get(callEdge.fromId)
      const to = graph.byId.get(callEdge.toId)
      const callerSource = parse(cache, boundary, fileOfNode(from))
      const targetSource = parse(cache, boundary, fileOfNode(to))
      if (!from || !to || !callerSource || !targetSource) { unsupported++; continue }
      const params = parametersFor(targetSource, to)
      const callsites = callsAt(callerSource, callEdge.line, cleanName(to.label))
      if (!callsites.length) { unsupported++; continue }
      for (const call of callsites.slice(0, 3)) {
        edges.push({
          from: callEdge.fromId, to: callEdge.toId, hop: current.hop + 1,
          file: fileOfNode(from), line: call.line,
          arguments: call.node.arguments.slice(0, 12).map((argument, index) => ({
            index, expression: argument.getText(callerSource).slice(0, 160), parameter: params[index] || null,
          })),
          state: 'EXTRACTED',
        })
        if (edges.length >= maxEdges) break
      }
      if (current.hop + 1 < depth) queue.push({id: callEdge.nextId, hop: current.hop + 1})
    }
  }
  return {
    model: 'bounded call-argument-to-parameter evidence (not CFG or taint analysis)',
    status: edges.length ? (unsupported ? 'PARTIAL' : 'COMPLETE') : 'UNAVAILABLE',
    edges, unsupportedEdges: unsupported, capped: edges.length >= maxEdges,
  }
}
