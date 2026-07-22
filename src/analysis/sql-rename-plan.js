// SQL rename backend (ADR 0002). weavatrix indexes SQL as a textOnly scanner: table/view/
// function/column symbols with LINE-level (column-0) positions, and table-level `references`
// edges (usage:'sql') from .sql statements and embedded SQL in host code. Two honest
// consequences shape this backend: (1) names are located LEXICALLY on the recorded line, not
// by byte range; (2) ORM-generated and dynamically-built SQL is invisible, so completeness is
// ALWAYS PARTIAL — never a proven-total rename. Table/view/function renames rewrite the
// definition plus every table-reference the scanner saw. Column renames rewrite only the DDL
// definition confidently — the graph carries no column-level usage edges, so column usages are
// reported UNPROVEN, never guessed. Output is a real weavatrix.edit-plan.v1 (pure text edits).

import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {graphEndpointId, fileOfId} from '../graph/node-id.js'

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const SQL_IDENT_RE = /^[A-Za-z_][\w$]*$/
const bareName = (value) => String(value || '').replace(/[`"[\]]/g, '').split('.').pop().trim()
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

// Word-boundary occurrences of `name` on a 1-based line, where a word char is [A-Za-z0-9_$]
// (SQL identifiers include $). Quotes/backticks/brackets are boundaries, so a quoted "users"
// is matched and only the inner name is rewritten. Returns [{startChar, endChar}].
function occurrencesOnLine(content, line, name) {
    const text = content.split('\n')[line - 1]
    if (text === undefined) return []
    const hits = []
    let index = text.indexOf(name)
    while (index !== -1) {
        const before = text[index - 1]
        const after = text[index + name.length]
        const boundaryBefore = before === undefined || !/[A-Za-z0-9_$]/.test(before)
        const boundaryAfter = after === undefined || !/[A-Za-z0-9_$]/.test(after)
        if (boundaryBefore && boundaryAfter) hits.push({startChar: index, endChar: index + name.length})
        index = text.indexOf(name, index + 1)
    }
    return hits
}

function referenceLines(rawGraph, symbolId) {
    const byFile = new Map()
    for (const link of rawGraph.links || []) {
        if (String(link.relation) !== 'references' || link.usage !== 'sql') continue
        if (graphEndpointId(link.target) !== symbolId) continue
        const file = fileOfId(graphEndpointId(link.source))
        if (!file || !Number.isInteger(Number(link.line))) continue
        const lines = byFile.get(file) || byFile.set(file, new Set()).get(file)
        lines.add(Number(link.line))
    }
    return byFile
}

export function buildSqlRenamePlan({repoRoot, rawGraph, symbolId, newName} = {}) {
    if (!repoRoot || !rawGraph || !symbolId || !newName) throw new Error('sql rename requires repoRoot, rawGraph, symbolId, and newName')
    const id = String(symbolId)
    const node = (rawGraph.nodes || []).find((candidate) => String(candidate.id) === id)
    if (!node) return {status: 'NOT_FOUND', reason: 'the symbol is not present in the active graph'}
    const kind = String(node.symbol_kind || '')
    if (!['table', 'view', 'function', 'column'].includes(kind) || !String(node.source_file || '').endsWith('.sql')) {
        return {status: 'NOT_SUPPORTED', reason: 'SQL rename supports table/view/function/column symbols defined in .sql files'}
    }
    if (!SQL_IDENT_RE.test(String(newName))) return {status: 'INVALID_NEW_NAME', reason: 'new_name must be a valid SQL identifier'}
    const oldName = bareName(node.label || id.slice(id.indexOf('#') + 1))
    if (oldName === String(newName)) return {status: 'NO_CHANGE', reason: 'the symbol already has that name'}

    const declFile = fileOfId(id)
    const declSource = readFile(repoRoot, declFile)
    if (!declSource) return {status: 'SOURCE_UNAVAILABLE', reason: `${declFile}: unreadable or not UTF-8 text`}

    const editsByFile = new Map()
    const uncertain = []
    const warnings = new Set()
    const addEdit = (file, line, occ) => {
        const list = editsByFile.get(file) || editsByFile.set(file, []).get(file)
        list.push({startLine: line, startChar: occ.startChar, endLine: line, endChar: occ.endChar, before: oldName, after: String(newName), provenance: 'LEXICAL_EXACT'})
    }

    // definition edit (DDL): the defined name on the declaration line
    const declLine = lineOfId(id) || (Number(node?.source_range?.start?.line) + 1)
    const declHits = occurrencesOnLine(declSource.content, declLine, oldName)
    if (!declHits.length) return {status: 'STALE_GRAPH', reason: 'the definition name could not be located on its line; rebuild the graph'}
    addEdit(declFile, declLine, declHits[0])
    if (declHits.length > 1) warnings.add('AMBIGUOUS_DEFINITION_LINE')

    if (kind === 'column') {
        // no column-level usage edges exist in the graph: rename the DDL definition only and
        // be explicit that usages are not tracked, rather than lexically guess (id/name/status
        // collide everywhere)
        warnings.add('COLUMN_USAGES_NOT_TRACKED')
        return finalize({status: 'PLANNED', kind, oldName, newName, editsByFile, uncertain, warnings, rawGraph, repoRoot,
            completenessNote: 'only the column definition is rewritten; SQL has no column-level usage edges, so every usage (queries, ORMs, host code) is UNPROVEN — review with bulk_replace scoped to this column if needed'})
    }

    // table/view/function: rewrite every reference the scanner recorded, located per line
    for (const [file, lines] of referenceLines(rawGraph, id)) {
        const source = file === declFile ? declSource : readFile(repoRoot, file)
        if (!source) { uncertain.push({file, reason: 'SOURCE_UNAVAILABLE'}); continue }
        for (const line of lines) {
            const hits = occurrencesOnLine(source.content, line, oldName)
            if (!hits.length) { uncertain.push({file, line, reason: 'REFERENCE_NOT_ON_RECORDED_LINE'}); continue }
            for (const hit of hits) addEdit(file, line, hit)
            if (hits.length > 1) warnings.add('MULTIPLE_OCCURRENCES_PER_LINE')
        }
    }
    warnings.add('ORM_AND_DYNAMIC_SQL_INVISIBLE')
    if (uncertain.length) warnings.add('UNCERTAIN_REFERENCES_PRESENT')
    return finalize({status: 'PLANNED', kind, oldName, newName, editsByFile, uncertain, warnings, rawGraph, repoRoot,
        completenessNote: 'references are those the SQL scanner could read; ORM-generated and dynamically-built SQL is invisible, so this rename is never proven total — run verified_change and inspect ORM/query-builder call sites'})
}

function finalize({status, kind, oldName, newName, editsByFile, uncertain, warnings, rawGraph, repoRoot, completenessNote}) {
    const files = [...editsByFile.entries()].map(([path, edits]) => {
        const source = readFile(repoRoot, path)
        return {path, sha256: sha256Hex(source ? source.buffer : Buffer.from('')), edits}
    })
    return {
        status, kind, oldName, newName: String(newName),
        completeness: 'PARTIAL',
        plan: {
            schemaVersion: 'weavatrix.edit-plan.v1',
            operation: kind === 'column' ? 'rename_field' : 'rename_table',
            createdAt: new Date().toISOString(),
            graphRevision: rawGraph.graphRevision || null,
            completeness: 'PARTIAL',
            files,
            uncertainReferences: uncertain,
            notModified: [],
            warnings: [...warnings],
            followUp: `${completenessNote}; then run verified_change phase=verify`,
        },
    }
}
