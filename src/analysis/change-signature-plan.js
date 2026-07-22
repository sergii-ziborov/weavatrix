// change_signature plan producer (ADR 0002, JS/TS, plan-only). Standard LSP has no
// changeSignature request, so this composes it from graph `calls` edges (call-site
// discovery) and tree-sitter argument surgery (js-call-sites.js) into a
// weavatrix.edit-plan.v1. v1 supports add_parameter (at end) and remove_parameter (by
// index); reorder is v1.1. Call-site discovery via graph edges is not statically provable to
// be COMPLETE, so the plan is labeled PARTIAL and the caller must run verified_change, whose
// type errors catch any missed site. Spread/apply and value-requiring adds are reported
// UNCERTAIN, never guessed.

import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {graphEndpointId, fileOfId} from '../graph/node-id.js'
import {findCallSites, findParameterList, grammarForFile, parseJsTs} from './js-call-sites.js'

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const bareName = (value) => String(value || '').replace(/\s*\(.*$/, '').replace(/[()]/g, '').trim()
const lineOfId = (id) => { const match = /@(\d+)$/.exec(String(id)); return match ? Number(match[1]) : 0 }

function readFile(repoRoot, file) {
    try {
        const buffer = readFileSync(resolve(repoRoot, file))
        const content = buffer.toString('utf8')
        return Buffer.from(content, 'utf8').equals(buffer) ? {content, buffer} : null
    } catch {
        return null
    }
}

// Byte-exact deletion range for the item at `index` (a parameter or an argument), consuming
// exactly one separating comma so the list stays well-formed.
function removalRange(items, index, content) {
    const count = items.length
    const item = items[index]
    let from
    let to
    if (count === 1) { from = item.start; to = item.end }
    else if (index < count - 1) { from = item.start; to = items[index + 1].start }
    else { from = items[index - 1].end; to = item.end }
    return {startLine: from.line, startChar: from.char, endLine: to.line, endChar: to.char, before: content.slice(from.index, to.index), after: ''}
}

function callSitesByFile(rawGraph, symbolId) {
    const byFile = new Map()
    for (const link of rawGraph.links || []) {
        if (String(link.relation) !== 'calls') continue
        if (graphEndpointId(link.target) !== symbolId) continue
        const file = fileOfId(graphEndpointId(link.source))
        if (!file || !Number.isInteger(Number(link.line))) continue
        const lines = byFile.get(file) || byFile.set(file, new Set()).get(file)
        lines.add(Number(link.line))
    }
    return byFile
}

async function planCallSite({content, name, line, operation, edits, uncertain, file}) {
    const tree = await parseJsTs(content, grammarForFile(file))
    const sites = findCallSites(tree, name, line)
    if (!sites.length) { uncertain.push({file, line, reason: 'CALL_SITE_NOT_LOCATED'}); return }
    for (const site of sites) {
        if (operation.kind === 'add_parameter') {
            if (operation.default === undefined) uncertain.push({file, line, reason: 'CALL_SITE_NEEDS_ARGUMENT_VALUE'})
            continue
        }
        // remove_parameter
        if (site.hasSpread) { uncertain.push({file, line, reason: 'SPREAD_ARGUMENT'}); continue }
        if (operation.index >= site.args.length) continue // the call did not pass this argument
        edits.push({file, ...removalRange(site.args, operation.index, content), provenance: 'RESOLVED'})
    }
}

export async function buildChangeSignaturePlan({repoRoot, rawGraph, symbolId, operation} = {}) {
    if (!repoRoot || !rawGraph || !symbolId || !operation) throw new Error('change_signature requires repoRoot, rawGraph, symbolId, and operation')
    const id = String(symbolId)
    if (!['add_parameter', 'remove_parameter'].includes(operation.kind)) {
        return {status: 'INVALID_OPERATION', reason: 'operation.kind must be add_parameter or remove_parameter (reorder is not yet supported)'}
    }
    if (operation.kind === 'add_parameter' && !IDENTIFIER_RE.test(String(operation.name || ''))) {
        return {status: 'INVALID_OPERATION', reason: 'add_parameter requires a valid identifier name'}
    }
    if (operation.kind === 'remove_parameter' && (!Number.isInteger(operation.index) || operation.index < 0)) {
        return {status: 'INVALID_OPERATION', reason: 'remove_parameter requires a non-negative integer index'}
    }
    if (!id.includes('#')) return {status: 'NOT_A_SYMBOL', reason: 'change_signature operates on a function/method symbol (file#name@line)'}
    const node = (rawGraph.nodes || []).find((candidate) => String(candidate.id) === id)
    if (!node) return {status: 'NOT_FOUND', reason: 'the symbol is not present in the active graph'}
    const declFile = fileOfId(id)
    if (!grammarForFile(declFile)) return {status: 'NOT_SUPPORTED', reason: 'change_signature currently supports JavaScript and TypeScript symbols'}
    const name = bareName(node.label || id.slice(id.indexOf('#') + 1))
    const declSource = readFile(repoRoot, declFile)
    if (!declSource) return {status: 'SOURCE_UNAVAILABLE', reason: `${declFile}: unreadable or not UTF-8 text`}

    const declTree = await parseJsTs(declSource.content, grammarForFile(declFile))
    const params = findParameterList(declTree, name, lineOfId(id))
    if (!params) return {status: 'STALE_GRAPH', reason: 'the declaration parameter list could not be located; rebuild the graph'}

    const editsByFile = new Map()
    const uncertain = []
    const warnings = new Set()
    const pushEdit = (edit) => {
        const list = editsByFile.get(edit.file) || editsByFile.set(edit.file, []).get(edit.file)
        list.push({startLine: edit.startLine, startChar: edit.startChar, endLine: edit.endLine, endChar: edit.endChar, before: edit.before, after: edit.after, provenance: edit.provenance})
    }

    // declaration edit
    if (operation.kind === 'add_parameter') {
        const fragment = `${params.params.length ? ', ' : ''}${operation.name}${operation.default !== undefined ? ` = ${operation.default}` : ''}`
        pushEdit({file: declFile, startLine: params.close.line, startChar: params.close.char, endLine: params.close.line, endChar: params.close.char, before: '', after: fragment, provenance: 'EXTRACTED'})
        if (operation.default === undefined) warnings.add('ADDED_PARAMETER_HAS_NO_DEFAULT')
    } else {
        if (operation.index >= params.params.length) return {status: 'INVALID_OPERATION', reason: `parameter index ${operation.index} is out of range (${params.params.length} parameters)`}
        const removed = params.params[operation.index]
        pushEdit({file: declFile, ...removalRange(params.params, operation.index, declSource.content), provenance: 'EXTRACTED'})
        if (/[([]|\bnew\b|=|\+\+|--/.test(removed.text)) warnings.add('REMOVED_PARAMETER_MAY_HAVE_DEFAULT_SIDE_EFFECT')
    }

    // call sites, grouped per file (parse each file once)
    const callEdits = []
    const contentCache = new Map([[declFile, declSource.content]])
    for (const [file, lines] of callSitesByFile(rawGraph, id)) {
        let content = contentCache.get(file)
        if (content === undefined) {
            const source = readFile(repoRoot, file)
            if (!source) { uncertain.push({file, reason: 'SOURCE_UNAVAILABLE'}); continue }
            content = source.content
            contentCache.set(file, content)
        }
        for (const line of lines) await planCallSite({content, name, line, operation, edits: callEdits, uncertain, file})
    }
    for (const edit of callEdits) pushEdit(edit)

    warnings.add('CALL_SITES_FROM_GRAPH_ONLY')
    if (uncertain.length) warnings.add('UNCERTAIN_CALL_SITES_PRESENT')

    const files = [...editsByFile.entries()].map(([file, edits]) => {
        const source = contentCache.get(file) ?? readFile(repoRoot, file)?.content
        return {path: file, sha256: sha256Hex(Buffer.from(source ?? '', 'utf8')), edits}
    })
    return {
        status: 'PLANNED',
        symbol: name,
        operation: operation.kind,
        completeness: 'PARTIAL',
        plan: {
            schemaVersion: 'weavatrix.edit-plan.v1',
            operation: 'change_signature',
            createdAt: new Date().toISOString(),
            graphRevision: rawGraph.graphRevision || null,
            completeness: 'PARTIAL',
            files,
            uncertainReferences: uncertain,
            notModified: [],
            warnings: [...warnings],
            followUp: 'call sites were discovered from graph edges (not proven complete); apply and run verified_change phase=verify so type errors surface any missed site',
        },
    }
}
