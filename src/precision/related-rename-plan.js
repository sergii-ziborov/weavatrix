// Coordinated multi-symbol rename as ONE atomic weavatrix.edit-plan.v1. Every individual
// rename is computed by the language server against the SAME repository snapshot, then the
// sub-plans are merged with cross-rename conflict detection. Simultaneous-snapshot
// semantics make chains and swaps well-defined (A->B, B->A both resolve against the
// original names), which sequential IDE renames cannot express. All-or-nothing: any
// failed or conflicting sub-rename blocks the whole plan — never a partial coordination.

import {createHash} from 'node:crypto'
import {buildRenamePlan} from './rename-plan.js'
import {createTypeScriptLspClient} from './typescript-provider/client.js'

const MAX_RENAMES = 16

const positionLessOrEqual = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])
const editStart = (edit) => [edit.startLine, edit.startChar]
const editEnd = (edit) => [edit.endLine, edit.endChar]
const editsOverlap = (a, b) => !positionLessOrEqual(editEnd(a), editStart(b)) && !positionLessOrEqual(editEnd(b), editStart(a))
const sameRange = (a, b) => a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar

// One language server for the whole batch: close/kill become no-ops for the inner plans
// and duplicate didOpen notifications are suppressed, so every sub-rename shares the
// same project session and the same document snapshots. The suppression doubles as the
// snapshot guard: re-opening a file whose text drifted since its first open throws, which
// buildRenamePlan converts to LSP_FAILED and the batch fails closed as BLOCKED — the
// server would otherwise keep the OLD text and the applier's hash check could not catch
// the resulting coordinate skew.
function sharedClientFactory(realClient) {
    const openedHashes = new Map()
    return async () => ({
        ...realClient,
        async openDocument(relPath, text, languageId) {
            const textHash = createHash('sha256').update(text).digest('hex')
            if (openedHashes.has(relPath)) {
                if (openedHashes.get(relPath) !== textHash) {
                    throw new Error(`repository changed during coordinated planning: ${relPath} drifted between sub-renames`)
                }
                return {file: relPath}
            }
            const result = await realClient.openDocument(relPath, text, languageId)
            openedHashes.set(relPath, textHash)
            return result
        },
        async close() {},
        kill() {},
    })
}

function validateRenames(renames) {
    if (!Array.isArray(renames) || !renames.length) return 'renames must be a non-empty array of {targetId, newName}'
    if (renames.length > MAX_RENAMES) return `at most ${MAX_RENAMES} coordinated renames are supported per call`
    const ids = new Set()
    for (const rename of renames) {
        if (!rename || typeof rename !== 'object' || !rename.targetId || typeof rename.newName !== 'string') {
            return 'each rename must provide targetId and newName'
        }
        if (ids.has(String(rename.targetId))) return `duplicate targetId: ${rename.targetId}`
        ids.add(String(rename.targetId))
    }
    return null
}

function mergeSubPlans(results) {
    const byFile = new Map()
    const conflicts = []
    for (const result of results) {
        for (const fileEntry of result.plan.files) {
            if (!byFile.has(fileEntry.path)) byFile.set(fileEntry.path, {path: fileEntry.path, sha256: fileEntry.sha256, edits: [], owners: []})
            const merged = byFile.get(fileEntry.path)
            if (merged.sha256 !== fileEntry.sha256) {
                conflicts.push({path: fileEntry.path, between: [merged.owners[0] || 'earlier rename', result.oldName], reason: 'snapshot drift: the file changed on disk between sub-renames'})
                continue
            }
            for (const edit of fileEntry.edits) {
                const duplicate = merged.edits.findIndex((existing) => sameRange(existing, edit))
                if (duplicate >= 0) {
                    const existing = merged.edits[duplicate]
                    if (existing.after === edit.after && existing.before === edit.before) continue
                    conflicts.push({path: fileEntry.path, at: `${edit.startLine}:${edit.startChar}`, between: [merged.owners[duplicate], result.oldName], reason: 'two renames rewrite the same range differently'})
                    continue
                }
                const overlapping = merged.edits.findIndex((existing) => editsOverlap(existing, edit))
                if (overlapping >= 0) {
                    conflicts.push({path: fileEntry.path, at: `${edit.startLine}:${edit.startChar}`, between: [merged.owners[overlapping], result.oldName], reason: 'edit ranges overlap'})
                    continue
                }
                merged.edits.push(edit)
                merged.owners.push(result.oldName)
            }
        }
    }
    const files = [...byFile.values()].map(({path, sha256, edits}) => ({path, sha256, edits}))
    return {files, conflicts}
}

export async function buildRelatedRenamePlan({
    repoRoot,
    rawGraph,
    renames,
    clientFactory,
    createClient = createTypeScriptLspClient,
    timeoutMs = 30_000,
} = {}) {
    if (!repoRoot || !rawGraph) throw new Error('related rename requires repoRoot and rawGraph')
    const invalid = validateRenames(renames)
    if (invalid) return {status: 'INVALID_RENAMES', reason: invalid}

    // simultaneous-snapshot semantics: warn when names chain or swap so the agent reads
    // the result as "all old names resolve against the original file state"
    const oldById = new Map()
    const warnings = new Set()
    let realClient = null
    let facade = null
    const factory = clientFactory || (async (options) => {
        // ONE facade per batch: its opened-hash map is the cross-sub-rename dedupe AND
        // the snapshot-drift guard, so it must never be recreated mid-batch
        if (!realClient) {
            realClient = await createClient(options)
            facade = sharedClientFactory(realClient)
        }
        return facade()
    })

    const results = []
    const failures = []
    try {
        for (const rename of renames) {
            const result = await buildRenamePlan({
                repoRoot,
                rawGraph,
                targetId: rename.targetId,
                newName: rename.newName,
                clientFactory: factory,
                timeoutMs,
            })
            if (result.status !== 'PLANNED') {
                failures.push({targetId: String(rename.targetId), newName: rename.newName, status: result.status, reason: result.reason})
            } else {
                oldById.set(String(rename.targetId), result.oldName)
                results.push({...result, targetId: String(rename.targetId)})
            }
        }
    } finally {
        if (realClient) {
            try {
                await realClient.close()
            } catch {
                realClient.kill?.()
            }
        }
    }
    if (failures.length) {
        return {
            status: 'BLOCKED',
            reason: 'coordinated rename is all-or-nothing; at least one sub-rename could not be planned',
            failures,
            planned: results.map((result) => ({targetId: result.targetId, oldName: result.oldName, newName: result.newName})),
        }
    }

    const oldNames = new Set(oldById.values())
    const newNames = new Set()
    for (const result of results) {
        // a new name that is also some rename's OLD name = chain/swap: valid, but only
        // under simultaneous-snapshot semantics — surface that explicitly
        if (oldNames.has(result.newName)) warnings.add('RENAME_CHAIN_SIMULTANEOUS')
        if (newNames.has(result.newName)) warnings.add('POSSIBLE_NEW_NAME_COLLISION')
        newNames.add(result.newName)
    }

    const {files, conflicts} = mergeSubPlans(results)
    if (conflicts.length) {
        return {status: 'CONFLICT', reason: 'renames rewrite overlapping ranges; resolve them into separate sequential renames', conflicts}
    }

    const uncertainReferences = results.flatMap((result) => result.plan.uncertainReferences.map((reference) => ({...reference, symbol: result.oldName})))
    const notModified = results.flatMap((result) => result.plan.notModified.map((entry) => ({...entry, symbol: result.oldName})))
    for (const result of results) {
        for (const warning of result.plan.warnings) {
            // a chain/swap sub-rename sees its sibling's OLD name in the files and flags
            // shadowing — but those occurrences are renamed away in this same atomic
            // plan, so the standalone-rename warning is spurious here
            if (warning === 'POSSIBLE_SHADOWING' && oldNames.has(result.newName)) continue
            warnings.add(warning)
        }
    }
    const completeness = uncertainReferences.length || notModified.length ? 'PARTIAL' : 'COMPLETE'

    return {
        status: 'PLANNED',
        renames: results.map((result) => ({
            targetId: result.targetId,
            oldName: result.oldName,
            newName: result.newName,
            edits: result.renamedEdits,
        })),
        completeness,
        plan: {
            schemaVersion: 'weavatrix.edit-plan.v1',
            operation: 'rename_related_symbols',
            createdAt: new Date().toISOString(),
            graphRevision: rawGraph.graphRevision || null,
            completeness,
            files,
            uncertainReferences,
            notModified,
            warnings: [...warnings],
            followUp: 'apply with weavatrix-refactor apply_edit_plan (preview -> confirm) or your editor, then run verified_change phase=verify',
        },
    }
}
