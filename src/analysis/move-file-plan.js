// move_file plan producer (ADR 0002, plan-only): relocates a file and rewrites the import
// specifiers that a relocation invalidates — the moved file's own relative imports and
// every importer that reaches it — then reports the architecture dry-run verdict for the
// new location. A file move is not a pure text edit (it renames a file, which the
// weavatrix-refactor applier deliberately refuses), so this emits a REVIEW plan the calling
// agent applies (rename + edits), not a weavatrix.edit-plan.v1 envelope. Every specifier the
// arithmetic cannot prove is reported UNCERTAIN, never rewritten wrongly.

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {verifyArchitecture} from './architecture/contract-verification.js'
import {isRelativeSpecifier, rewriteRelativeSpecifier, specifierDirOf} from './import-specifier.js'

const IMPORT_RELATIONS = new Set(['imports', 're_exports'])
const JS_TS_FILE_RE = /\.(?:[cm]?[jt]sx?)$/i

const endpointId = (endpoint) => (endpoint && typeof endpoint === 'object' ? String(endpoint.id || '') : String(endpoint || ''))

// Relabels the moved file and all of its symbols/edges to the new path. Pure: returns a new
// graph object leaving the input untouched, so the caller can diff before against after.
export function simulateFileMove(graph, oldPath, newPath) {
    const remap = (id) => {
        const value = String(id)
        if (value === oldPath) return newPath
        if (value.startsWith(`${oldPath}#`)) return `${newPath}${value.slice(oldPath.length)}`
        return value
    }
    const remapEndpoint = (endpoint) => (endpoint && typeof endpoint === 'object'
        ? {...endpoint, id: remap(endpoint.id)}
        : remap(endpoint))
    const nodes = (graph.nodes || []).map((node) => {
        const id = remap(node.id)
        if (id === node.id && node.source_file !== oldPath) return node
        return {...node, id, ...(node.source_file === oldPath ? {source_file: newPath} : {})}
    })
    const links = (graph.links || []).map((link) => {
        const source = remapEndpoint(link.source)
        const target = remapEndpoint(link.target)
        if (source === link.source && target === link.target) return link
        return {...link, source, target}
    })
    return {...graph, nodes, links}
}

function architectureDryRun(graph, simulated, contract) {
    if (!contract) return {status: 'NOT_CONFIGURED', reason: 'no architecture contract is active; the move has no architecture verdict'}
    let before
    let after
    try {
        before = verifyArchitecture({graph, contract})
        after = verifyArchitecture({graph: simulated, contract})
    } catch (error) {
        return {status: 'UNAVAILABLE', reason: error?.message || 'architecture verification failed'}
    }
    const beforeActive = new Map([...before.new, ...before.existing].map((item) => [item.fingerprint, item]))
    const afterActive = new Map([...after.new, ...after.existing].map((item) => [item.fingerprint, item]))
    const wouldIntroduce = [...afterActive].filter(([fingerprint]) => !beforeActive.has(fingerprint)).map(([, item]) => item)
    const wouldFix = [...beforeActive].filter(([fingerprint]) => !afterActive.has(fingerprint)).map(([, item]) => item)
    const status = wouldIntroduce.length ? 'WOULD_VIOLATE' : wouldFix.length ? 'WOULD_IMPROVE' : 'NO_ARCHITECTURE_CHANGE'
    return {status, wouldIntroduce, wouldFix, violationsBefore: beforeActive.size, violationsAfter: afterActive.size}
}

// Exactly-one quoted occurrence of the raw specifier on a 1-based line, or null when the
// occurrence is absent or ambiguous (the caller then reports UNCERTAIN rather than guess).
function locateSpecifier(content, line, specifier) {
    const text = content.split('\n')[line - 1]
    if (text === undefined) return null
    const hits = []
    for (const quote of ['\'', '"', '`']) {
        const needle = `${quote}${specifier}${quote}`
        let index = text.indexOf(needle)
        while (index !== -1) {
            hits.push({startChar: index + 1, endChar: index + 1 + specifier.length})
            index = text.indexOf(needle, index + 1)
        }
    }
    return hits.length === 1 ? hits[0] : null
}

function readFile(repoRoot, file) {
    try {
        const buffer = readFileSync(resolve(repoRoot, file))
        const content = buffer.toString('utf8')
        return Buffer.from(content, 'utf8').equals(buffer) ? content : null
    } catch {
        return null
    }
}

function specifierEdit({content, file, line, specifier, newSpecifier, role}) {
    if (newSpecifier === specifier) return {skip: true}
    if (content === null) return {uncertain: {file, specifier, reason: 'SOURCE_UNAVAILABLE'}}
    const located = locateSpecifier(content, line, specifier)
    if (!located) return {uncertain: {file, line, specifier, reason: 'SPECIFIER_NOT_LOCATED'}}
    return {edit: {file, startLine: line, startChar: located.startChar, endLine: line, endChar: located.endChar, before: specifier, after: newSpecifier, role}}
}

export function buildMoveFilePlan({repoRoot, rawGraph, fromPath, toPath, contract = null} = {}) {
    if (!repoRoot || !rawGraph || !fromPath || !toPath) throw new Error('move_file requires repoRoot, rawGraph, fromPath, and toPath')
    const oldPath = String(fromPath)
    const newPath = String(toPath)
    if (oldPath === newPath) return {status: 'NO_CHANGE', reason: 'source and target paths are identical'}
    if (!JS_TS_FILE_RE.test(oldPath) || !JS_TS_FILE_RE.test(newPath)) {
        return {status: 'NOT_SUPPORTED', reason: 'move_file specifier rewriting currently supports JavaScript and TypeScript files'}
    }
    const fileNode = (rawGraph.nodes || []).find((node) => String(node.id) === oldPath)
    if (!fileNode) return {status: 'NOT_FOUND', reason: 'the source file is not a node in the active graph'}
    if ((rawGraph.nodes || []).some((node) => String(node.id) === newPath)) {
        return {status: 'TARGET_EXISTS', reason: 'the target path already exists in the graph'}
    }

    const edits = []
    const uncertain = []
    const warnings = new Set()
    const editsByFile = new Map()
    const record = (result) => {
        if (result.skip) return
        if (result.uncertain) { uncertain.push(result.uncertain); return }
        const list = editsByFile.get(result.edit.file) || (editsByFile.set(result.edit.file, []).get(result.edit.file))
        list.push(result.edit)
        edits.push(result.edit)
    }

    const movedContent = readFile(repoRoot, oldPath)
    for (const link of rawGraph.links || []) {
        if (!IMPORT_RELATIONS.has(String(link.relation))) continue
        const source = endpointId(link.source)
        const target = endpointId(link.target)
        const specifier = typeof link.specifier === 'string' ? link.specifier : null
        if (target === oldPath && source !== oldPath) {
            // an importer of the moved file: its directory is unchanged, the target moved
            if (!specifier) { uncertain.push({file: source, reason: 'IMPORTER_EDGE_WITHOUT_SPECIFIER'}); continue }
            if (!isRelativeSpecifier(specifier)) { uncertain.push({file: source, specifier, reason: 'NON_RELATIVE_IMPORTER'}); continue }
            const rewrite = rewriteRelativeSpecifier({specifier, targetFile: newPath, newImporterDir: specifierDirOf(source)})
            if (rewrite.uncertain) { uncertain.push({file: source, specifier, reason: rewrite.reason}); continue }
            record(specifierEdit({content: readFile(repoRoot, source), file: source, line: Number(link.line), specifier, newSpecifier: rewrite.specifier, role: 'importer'}))
        } else if (source === oldPath) {
            // the moved file's own import: its directory changes, the target stays put
            if (!specifier || !isRelativeSpecifier(specifier)) continue
            const rewrite = rewriteRelativeSpecifier({specifier, targetFile: target, newImporterDir: specifierDirOf(newPath)})
            if (rewrite.uncertain) { uncertain.push({file: oldPath, specifier, reason: rewrite.reason}); continue }
            record(specifierEdit({content: movedContent, file: oldPath, line: Number(link.line), specifier, newSpecifier: rewrite.specifier, role: 'moved-file-self'}))
        }
    }
    if (uncertain.length) warnings.add('UNCERTAIN_SPECIFIERS_PRESENT')
    if (movedContent === null) warnings.add('MOVED_FILE_UNREADABLE')

    const simulated = simulateFileMove(rawGraph, oldPath, newPath)
    const architecture = architectureDryRun(rawGraph, simulated, contract)
    if (architecture.status === 'WOULD_VIOLATE') warnings.add('WOULD_INTRODUCE_ARCHITECTURE_VIOLATION')

    return {
        status: 'PLANNED',
        rename: {from: oldPath, to: newPath},
        completeness: uncertain.length ? 'PARTIAL' : 'COMPLETE',
        edits,
        editsByFile: [...editsByFile.entries()].map(([file, fileEdits]) => ({file, edits: fileEdits.length})),
        uncertain,
        architecture,
        warnings: [...warnings],
        followUp: 'apply the rename and edits with your editor (the moved file is renamed, which apply_edit_plan does not do), then run verified_change phase=verify',
        note: 'review plan, not an apply_edit_plan envelope: it renames a file. Cycle topology is invariant under a pure relocate; the architecture verdict is the load-bearing check.',
    }
}
