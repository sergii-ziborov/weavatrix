// Builds a weavatrix.edit-plan.v1 envelope for a symbol rename. Pure read: the bundled
// TypeScript language server computes the WorkspaceEdit, this module turns it into an
// hash-bound edit plan with honest uncertainty labels. Nothing here writes source files;
// applying a plan is owned by the separate weavatrix-refactor package (ADR 0002).

import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {createTypeScriptLspClient} from './typescript-provider/client.js'

const JS_TS_FILE_RE = /\.(?:[cm]?[jt]sx?)$/i
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const MAX_UNCERTAIN = 200

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

// Absolute string offset for a 0-based LSP position; fails closed outside the content.
function offsetAtLsp(content, line, character) {
    let lineStart = 0
    for (let current = 0; current < line; current += 1) {
        const nextBreak = content.indexOf('\n', lineStart)
        if (nextBreak === -1) throw new Error(`LSP position line ${line} exceeds file line count`)
        lineStart = nextBreak + 1
    }
    const offset = lineStart + character
    if (offset > content.length) throw new Error(`LSP position ${line}:${character} exceeds file length`)
    return offset
}

function graphReferenceInventory(rawGraph, targetId, declaringFile) {
    const nodesById = new Map((rawGraph.nodes || []).map((node) => [String(node?.id || ''), node]))
    const references = []
    for (const link of rawGraph.links || []) {
        if (String(link?.target || '') !== targetId) continue
        const source = nodesById.get(String(link?.source || ''))
        const file = String(source?.source_file || String(link?.source || '').split('#')[0] || '')
        if (!file || file === declaringFile) continue
        references.push({
            path: file,
            type: String(link?.type || 'reference'),
            ...(link?.confidence ? {provenance: String(link.confidence)} : {}),
            ...(Number.isInteger(link?.line) ? {line: link.line} : {}),
        })
    }
    return references.slice(0, MAX_UNCERTAIN)
}

function loadPlanFile(repoRoot, file) {
    let buffer
    try {
        buffer = readFileSync(resolve(repoRoot, file))
    } catch (error) {
        return {file, error: error?.message || 'file is unreadable'}
    }
    const content = buffer.toString('utf8')
    if (!Buffer.from(content, 'utf8').equals(buffer)) return {file, error: 'file is not valid UTF-8 text'}
    return {file, buffer, content}
}

const overlaps = (start, end, ranges) => ranges.some((range) => start < range.end && end > range.start)

// Word-boundary occurrences of `name` in `content` that no edit range covers.
function uncoveredOccurrences(content, name, coveredRanges) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, '\\$&')}(?![A-Za-z0-9_$])`, 'g')
    const found = []
    for (const match of content.matchAll(pattern)) {
        const start = match.index
        const end = start + name.length
        if (overlaps(start, end, coveredRanges)) continue
        const line = content.slice(0, start).split('\n').length
        found.push({line, excerpt: content.slice(Math.max(0, start - 30), end + 30).trim()})
    }
    return found
}

// Computes the rename plan for one symbol. Returns a status object; status 'PLANNED' carries
// the weavatrix.edit-plan.v1 envelope. Never throws for expected conditions — unsupported
// languages, missing selections and LSP failures are explicit statuses, not exceptions.
export async function buildRenamePlan({
    repoRoot,
    rawGraph,
    targetId,
    newName,
    clientFactory = createTypeScriptLspClient,
    timeoutMs = 30_000,
} = {}) {
    if (!repoRoot || !rawGraph || !targetId) throw new Error('rename plan requires repoRoot, rawGraph, and targetId')
    const id = String(targetId)
    const node = (rawGraph.nodes || []).find((candidate) => String(candidate?.id || '') === id)
    if (!node) return {status: 'NOT_FOUND', reason: 'the selected symbol is not present in the active graph'}
    const declaringFile = String(node.source_file || id.split('#')[0] || '')
    if (!JS_TS_FILE_RE.test(declaringFile) || !node.selection_start || !node.selection_end) {
        return {
            status: 'NOT_SUPPORTED',
            reason: 'exact rename planning currently supports JavaScript and TypeScript symbols with source selections; the graph reference inventory below is review evidence, not an edit plan',
            references: graphReferenceInventory(rawGraph, id, declaringFile),
        }
    }
    if (typeof newName !== 'string' || !IDENTIFIER_RE.test(newName)) {
        return {status: 'INVALID_NEW_NAME', reason: 'new_name must be a valid JavaScript identifier'}
    }

    const declaring = loadPlanFile(repoRoot, declaringFile)
    if (declaring.error) return {status: 'SOURCE_UNAVAILABLE', reason: `${declaringFile}: ${declaring.error}`}
    let oldName
    try {
        oldName = declaring.content.slice(
            offsetAtLsp(declaring.content, node.selection_start.line, node.selection_start.character),
            offsetAtLsp(declaring.content, node.selection_end.line, node.selection_end.character),
        )
    } catch (error) {
        return {status: 'STALE_GRAPH', reason: `the symbol selection no longer matches the file: ${error.message}`}
    }
    if (!IDENTIFIER_RE.test(oldName)) return {status: 'STALE_GRAPH', reason: 'the graph selection does not cover an identifier; rebuild the graph'}
    if (oldName === newName) return {status: 'NO_CHANGE', reason: 'the symbol already has that name'}

    // The graph is the project hint: opening every JS/TS file that references the symbol
    // pulls those files into the language server's (possibly inferred, tsconfig-less)
    // project, so cross-file renames work where a bare single-document session would
    // silently rename only the declaration.
    const loadedByPath = new Map([[declaringFile, declaring]])
    const sessionFiles = [declaringFile]
    for (const reference of graphReferenceInventory(rawGraph, id, declaringFile)) {
        if (sessionFiles.length >= 64) break
        if (!JS_TS_FILE_RE.test(reference.path) || loadedByPath.has(reference.path)) continue
        const loaded = loadPlanFile(repoRoot, reference.path)
        if (loaded.error) continue
        loadedByPath.set(reference.path, loaded)
        sessionFiles.push(reference.path)
    }
    let client = null
    let renamed
    try {
        // inside the try so a language-server startup failure is an honest LSP_FAILED
        // status, not an escaped exception
        client = await clientFactory({repoRoot, timeoutMs})
        for (const file of sessionFiles) await client.openDocument(file, loadedByPath.get(file).content)
        renamed = await client.rename(declaringFile, node.selection_start, newName, timeoutMs)
    } catch (error) {
        return {status: 'LSP_FAILED', reason: error?.message || 'textDocument/rename failed'}
    } finally {
        if (client) {
            try {
                await client.close()
            } catch {
                client.kill?.()
            }
        }
    }
    if (!renamed.files.length) return {status: 'NO_EDITS', reason: 'the language server returned no edits for this rename'}

    const warnings = []
    const notModified = []
    const uncertainReferences = []
    const planFiles = []
    if (renamed.resourceOperations) {
        warnings.push('RESOURCE_OPERATIONS_DROPPED')
        notModified.push({reason: `${renamed.resourceOperations} file create/rename/delete operation(s) proposed by the language server were dropped; only text edits are planned`})
    }
    for (const uri of renamed.outsideRepository) notModified.push({path: uri, reason: 'edit target is outside the repository'})

    for (const fileChange of renamed.files) {
        // prefer the session-time snapshot: the hash must describe exactly what the LSP saw
        const loaded = loadedByPath.get(fileChange.file) || loadPlanFile(repoRoot, fileChange.file)
        if (loaded.error) {
            notModified.push({path: fileChange.file, reason: loaded.error})
            continue
        }
        const covered = []
        const edits = []
        let rangeError = null
        for (const edit of fileChange.edits) {
            try {
                const start = offsetAtLsp(loaded.content, edit.range.start.line, edit.range.start.character)
                const end = offsetAtLsp(loaded.content, edit.range.end.line, edit.range.end.character)
                covered.push({start, end})
                edits.push({
                    startLine: edit.range.start.line + 1,
                    startChar: edit.range.start.character,
                    endLine: edit.range.end.line + 1,
                    endChar: edit.range.end.character,
                    before: loaded.content.slice(start, end),
                    after: edit.newText,
                    provenance: 'EXACT_LSP',
                })
            } catch (error) {
                rangeError = error.message
                break
            }
        }
        if (rangeError) {
            notModified.push({path: fileChange.file, reason: `language-server edit range no longer matches the file: ${rangeError}`})
            continue
        }
        if (!edits.length) continue
        planFiles.push({path: fileChange.file, sha256: sha256Hex(loaded.buffer), edits})
        for (const occurrence of uncoveredOccurrences(loaded.content, oldName, covered).slice(0, MAX_UNCERTAIN)) {
            uncertainReferences.push({path: fileChange.file, line: occurrence.line, kind: 'UNCOVERED_OCCURRENCE', excerpt: occurrence.excerpt})
        }
        if (uncoveredOccurrences(loaded.content, newName, []).length) warnings.push('POSSIBLE_SHADOWING')
    }
    if (!planFiles.length) return {status: 'NO_EDITS', reason: 'every proposed edit target was unreadable or stale', notModified}

    const editedFiles = new Set(planFiles.map((file) => file.path))
    for (const reference of graphReferenceInventory(rawGraph, id, declaringFile)) {
        if (editedFiles.has(reference.path)) continue
        if (uncertainReferences.length >= MAX_UNCERTAIN) break
        uncertainReferences.push({...reference, kind: 'GRAPH_REFERENCE_WITHOUT_EDIT'})
    }
    if (node.exported === true) warnings.push('PUBLIC_API_SYMBOL')

    const completeness = uncertainReferences.length || notModified.length ? 'PARTIAL' : 'COMPLETE'
    return {
        status: 'PLANNED',
        oldName,
        newName,
        plan: {
            schemaVersion: 'weavatrix.edit-plan.v1',
            operation: 'rename_symbol',
            createdAt: new Date().toISOString(),
            graphRevision: rawGraph.graphRevision || null,
            completeness,
            files: planFiles,
            uncertainReferences,
            notModified,
            warnings: [...new Set(warnings)],
            followUp: 'apply with weavatrix-refactor apply_edit_plan (preview -> confirm) or your editor, then run verified_change phase=verify',
        },
        renamedEdits: planFiles.reduce((sum, file) => sum + file.edits.length, 0),
        renamedFiles: planFiles.length,
        completeness,
    }
}
