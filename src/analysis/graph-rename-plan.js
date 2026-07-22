// Graph+lexical rename backend for the languages weavatrix indexes without a bundled LSP —
// Rust, Python, Go, Java, C#, Solidity. It generalizes the SQL rename pattern to symbols:
// the declaration and every call/reference the graph recorded are located LEXICALLY on their
// edge's line and rewritten, as a real weavatrix.edit-plan.v1. Because there is no language
// server, completeness is ALWAYS PARTIAL (parser-resolved edges are not proven total) and the
// locating rule is strict: a name is rewritten only when it occurs EXACTLY ONCE on the line
// (method/function names collide, so an ambiguous line is reported UNCERTAIN, never guessed).
// JS/TS keeps its EXACT_LSP rename; SQL keeps its table-aware backend.

import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve, extname} from 'node:path'
import {graphEndpointId, fileOfId} from '../graph/node-id.js'

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const GRAPH_RENAME_EXT = new Set(['.rs', '.py', '.go', '.java', '.cs', '.sol'])
const USE_RELATIONS = new Set(['calls', 'references'])
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/
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

// Word-boundary occurrences of `name` on a 1-based line (word char = [A-Za-z0-9_$]).
function occurrencesOnLine(content, line, name) {
    const text = content.split('\n')[line - 1]
    if (text === undefined) return []
    const hits = []
    let index = text.indexOf(name)
    while (index !== -1) {
        const before = text[index - 1]
        const after = text[index + name.length]
        if ((before === undefined || !/[A-Za-z0-9_$]/.test(before)) && (after === undefined || !/[A-Za-z0-9_$]/.test(after))) {
            hits.push({startChar: index, endChar: index + name.length})
        }
        index = text.indexOf(name, index + 1)
    }
    return hits
}

function referenceEdges(rawGraph, symbolId) {
    const byFileLine = new Map()
    const provenance = new Map()
    for (const link of rawGraph.links || []) {
        if (!USE_RELATIONS.has(String(link.relation))) continue
        if (graphEndpointId(link.target) !== symbolId) continue
        const file = fileOfId(graphEndpointId(link.source))
        const line = Number(link.line)
        if (!file || !Number.isInteger(line)) continue
        const key = `${file}\0${line}`
        byFileLine.set(key, {file, line})
        provenance.set(key, String(link.provenance || link.confidence || 'INFERRED'))
    }
    return {sites: [...byFileLine.values()], provenance}
}

function hasInheritanceEdge(rawGraph, symbolId) {
    return (rawGraph.links || []).some((link) =>
        ['inherits', 'implements', 'overrides'].includes(String(link.relation))
        && (graphEndpointId(link.source) === symbolId || graphEndpointId(link.target) === symbolId))
}

export function buildGraphRenamePlan({repoRoot, rawGraph, symbolId, newName} = {}) {
    if (!repoRoot || !rawGraph || !symbolId || !newName) throw new Error('graph rename requires repoRoot, rawGraph, symbolId, and newName')
    const id = String(symbolId)
    if (!id.includes('#')) return {status: 'NOT_A_SYMBOL', reason: 'graph rename operates on a symbol (file#name@line)'}
    const declFile = fileOfId(id)
    const ext = extname(declFile).toLowerCase()
    if (/\.(?:[cm]?[jt]sx?)$/i.test(declFile)) return {status: 'USE_LSP_BACKEND', reason: 'JavaScript/TypeScript symbols rename through the exact LSP backend'}
    if (ext === '.sql') return {status: 'USE_SQL_BACKEND', reason: 'SQL schema objects rename through the SQL backend'}
    if (!GRAPH_RENAME_EXT.has(ext)) return {status: 'NOT_SUPPORTED', reason: `graph rename supports ${[...GRAPH_RENAME_EXT].join(', ')}`}
    if (!IDENT_RE.test(String(newName))) return {status: 'INVALID_NEW_NAME', reason: 'new_name must be a valid identifier'}
    const node = (rawGraph.nodes || []).find((candidate) => String(candidate.id) === id)
    if (!node) return {status: 'NOT_FOUND', reason: 'the symbol is not present in the active graph'}
    const oldName = bareName(node.label || id.slice(id.indexOf('#') + 1))
    if (!IDENT_RE.test(oldName)) return {status: 'STALE_GRAPH', reason: 'the symbol name is not a plain identifier'}
    if (oldName === String(newName)) return {status: 'NO_CHANGE', reason: 'the symbol already has that name'}

    const declSource = readFile(repoRoot, declFile)
    if (!declSource) return {status: 'SOURCE_UNAVAILABLE', reason: `${declFile}: unreadable or not UTF-8 text`}

    const editsByFile = new Map()
    const uncertain = []
    const warnings = new Set(['NO_LSP_COMPLETENESS_UNPROVEN'])
    const contentCache = new Map([[declFile, declSource.content]])
    const addEdit = (file, line, occ, provenance) => {
        const list = editsByFile.get(file) || editsByFile.set(file, []).get(file)
        list.push({startLine: line, startChar: occ.startChar, endLine: line, endChar: occ.endChar, before: oldName, after: String(newName), provenance})
    }

    // declaration
    const declLine = lineOfId(id) || (Number(node?.source_range?.start?.line) + 1)
    const declHits = occurrencesOnLine(declSource.content, declLine, oldName)
    if (declHits.length !== 1) return {status: 'STALE_GRAPH', reason: `the declaration name occurs ${declHits.length} time(s) on its line; cannot locate it unambiguously`}
    addEdit(declFile, declLine, declHits[0], 'EXTRACTED')

    // references: exactly one occurrence per line, else UNCERTAIN
    const {sites, provenance} = referenceEdges(rawGraph, id)
    for (const site of sites) {
        let content = contentCache.get(site.file)
        if (content === undefined) {
            const source = readFile(repoRoot, site.file)
            if (!source) { uncertain.push({file: site.file, line: site.line, reason: 'SOURCE_UNAVAILABLE'}); continue }
            content = source.content
            contentCache.set(site.file, content)
        }
        const hits = occurrencesOnLine(content, site.line, oldName)
        if (hits.length !== 1) { uncertain.push({file: site.file, line: site.line, reason: hits.length ? 'AMBIGUOUS_LINE_MULTIPLE_OCCURRENCES' : 'REFERENCE_NOT_ON_RECORDED_LINE'}); continue }
        // located lexically with byte-exact before-text -> LEXICAL_EXACT (applyable), regardless
        // of the discovering edge's parser confidence, which is recorded on the uncertain path only
        void provenance
        addEdit(site.file, site.line, hits[0], 'LEXICAL_EXACT')
    }
    if (hasInheritanceEdge(rawGraph, id)) warnings.add('POSSIBLE_OVERRIDE_OR_IMPLEMENTATION_RENAME_NEEDED')
    if (uncertain.length) warnings.add('UNCERTAIN_REFERENCES_PRESENT')

    const files = [...editsByFile.entries()].map(([path, edits]) => {
        const source = contentCache.get(path)
        return {path, sha256: sha256Hex(Buffer.from(source ?? '', 'utf8')), edits}
    })
    return {
        status: 'PLANNED',
        symbol: oldName,
        language: ext.slice(1),
        completeness: 'PARTIAL',
        plan: {
            schemaVersion: 'weavatrix.edit-plan.v1',
            operation: 'rename_symbol',
            createdAt: new Date().toISOString(),
            graphRevision: rawGraph.graphRevision || null,
            completeness: 'PARTIAL',
            files,
            uncertainReferences: uncertain,
            notModified: [],
            warnings: [...warnings],
            followUp: 'no language server backs this rename, so call sites came from parser-resolved graph edges and are not proven complete; apply and run verified_change phase=verify, and inspect dynamic/reflection call paths',
        },
    }
}
