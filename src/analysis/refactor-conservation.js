// Call-edge conservation ratchet for post-refactor verification: proves that every caller
// a symbol had BEFORE a refactor still reaches it AFTER. Pure over two graph objects.
// Node ids embed the declaration line (file#name@line), so any edit that shifts lines
// renames ids and a naive id comparison reports false orphans; this matcher keys symbols
// and callers by (source_file, bare name, edge type) instead, mapping declared renames
// and file moves so a refactored symbol is compared against its own new identity.
// The dangerous direction is a false CONSERVED — every ambiguity resolves against it:
// edge types are part of the identity, mapped callers never fall back to a recycled old
// name, shrunken same-name declaration counts surface as warnings, and a baseline this
// matcher could not fully index is reported as such instead of silently blessed.

const STRUCTURAL_TYPES = new Set(['contains', 'member_of', 'defines', 'declares'])
const MAX_REPORTED = 200
const MAX_MOVE_HOPS = 8

const bareName = (value) => String(value || '').replace(/\s*\(.*$/, '').replace(/[()]/g, '').trim()

// name from a file#name@line id when the node has no label; the @line suffix must never
// leak into the identity or pure line churn would report false losses
const nameFromId = (id) => {
    const match = /#([^#@]+)(?:@\d+)?$/.exec(String(id || ''))
    return match ? bareName(match[1]) : ''
}

// '\0' cannot appear in file paths or identifiers, so composite keys are unambiguous
const keyOf = (file, name) => `${file}\0${name}`

// Applies declared moves (composed to a fixpoint with a hop guard) and renames
// (file-scoped declarations take precedence over unscoped ones; the scope may name the
// baseline file or the post-move destination). Returns the expected post-refactor identity.
function expectedIdentity(file, name, renames, moves) {
    let nextFile = file
    for (let hop = 0; hop < MAX_MOVE_HOPS; hop += 1) {
        const move = moves.find((candidate) => candidate.fromFile === nextFile)
        if (!move || move.toFile === nextFile) break
        nextFile = move.toFile
    }
    const applicable = renames.filter((rename) => rename.oldName === name
        && (!rename.file || rename.file === file || rename.file === nextFile))
    const scoped = applicable.find((rename) => rename.file)
    const chosen = scoped || applicable[0]
    const nextName = chosen ? chosen.newName : name
    return {file: nextFile, name: nextName, key: keyOf(nextFile, nextName), mapped: nextFile !== file || nextName !== name}
}

// symbol key -> callers keyed by (file, name, edge type). Same-named declarations in one
// file merge for caller matching (id churn safety), but their COUNT is tracked so a
// deleted overload cannot hide behind a surviving sibling.
function inboundIndex(graph) {
    const nodesById = new Map((graph.nodes || []).map((node) => [String(node?.id || ''), node]))
    const index = new Map()
    let totalLinks = 0
    let skippedLinks = 0
    for (const link of graph.links || []) {
        const type = String(link?.type || '')
        if (STRUCTURAL_TYPES.has(type)) continue
        totalLinks += 1
        const target = nodesById.get(String(link?.target || ''))
        const source = nodesById.get(String(link?.source || ''))
        const targetFile = String(target?.source_file || '')
        const targetName = bareName(target?.label) || nameFromId(target?.id)
        const sourceFile = String(source?.source_file || '')
        const sourceName = bareName(source?.label) || nameFromId(source?.id)
        if (!target || !source || !targetFile || !targetName || !sourceName) {
            skippedLinks += 1
            continue
        }
        const key = keyOf(targetFile, targetName)
        if (!index.has(key)) index.set(key, {file: targetFile, name: targetName, callers: new Map()})
        index.get(key).callers.set(`${keyOf(sourceFile, sourceName)}\0${type}`, {file: sourceFile, name: sourceName, type})
    }
    return {index, totalLinks, skippedLinks}
}

function declarationCounts(graph) {
    const counts = new Map()
    for (const node of graph.nodes || []) {
        const file = String(node?.source_file || '')
        const name = bareName(node?.label) || nameFromId(node?.id)
        if (!file || !name || !String(node?.id || '').includes('#')) continue
        const key = keyOf(file, name)
        counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
}

// Compares inbound non-structural edges across a refactor. CONSERVED only when every
// pre-refactor caller edge (by file, name AND type) still reaches the symbol's declared
// post-refactor identity, the baseline was fully indexable, and no same-name declaration
// count shrank. New callers are information, never blockers.
export function verifyRefactorConservation({baselineGraph, currentGraph, renames = [], moves = []} = {}) {
    if (!baselineGraph || !currentGraph) throw new Error('conservation requires baselineGraph and currentGraph')
    const baseline = inboundIndex(baselineGraph)
    const current = inboundIndex(currentGraph)
    const baselineDecls = declarationCounts(baselineGraph)
    const currentDecls = declarationCounts(currentGraph)
    const currentNodeKeys = new Set(currentDecls.keys())

    const symbols = []
    const missingSymbols = []
    const warnings = []
    let lostTotal = 0
    let missingTotal = 0
    for (const [baselineKey, entry] of baseline.index) {
        const expected = expectedIdentity(entry.file, entry.name, renames, moves)
        const after = current.index.get(expected.key)
        if (!after && !currentNodeKeys.has(expected.key)) {
            missingTotal += 1
            if (missingSymbols.length < MAX_REPORTED) {
                missingSymbols.push({name: entry.name, file: entry.file, expectedName: expected.name, expectedFile: expected.file, baselineCallers: entry.callers.size})
            }
            continue
        }
        const beforeDecls = baselineDecls.get(baselineKey) || 0
        const afterDecls = currentDecls.get(expected.key) || 0
        if (afterDecls < beforeDecls && warnings.length < MAX_REPORTED) {
            warnings.push({kind: 'DECLARATION_COUNT_SHRUNK', file: entry.file, name: entry.name, before: beforeDecls, after: afterDecls, detail: 'same-named declarations merged for caller matching; one of them disappeared — verify the deletion was intended'})
        }
        const afterCallers = after ? after.callers : new Map()
        const lost = []
        let lostHere = 0
        let conserved = 0
        for (const [callerKey, caller] of entry.callers) {
            const mappedCaller = expectedIdentity(caller.file, caller.name, renames, moves)
            // a mapped caller must be found under its NEW identity only: the old
            // (file, name) may have been recycled by an unrelated new symbol
            const found = mappedCaller.mapped
                ? afterCallers.has(`${mappedCaller.key}\0${caller.type}`)
                : afterCallers.has(callerKey)
            if (found) {
                conserved += 1
            } else {
                lostHere += 1
                if (lost.length < MAX_REPORTED) lost.push({file: caller.file, name: caller.name, type: caller.type})
            }
        }
        lostTotal += lostHere
        if (lostHere && symbols.length < MAX_REPORTED) {
            symbols.push({
                name: entry.name,
                file: entry.file,
                ...(expected.mapped ? {expectedName: expected.name, expectedFile: expected.file} : {}),
                baselineCallers: entry.callers.size,
                conserved,
                lostCount: lostHere,
                lost,
                newCallers: Math.max(0, afterCallers.size - conserved),
            })
        }
    }

    const coverage = {
        baselineLinks: baseline.totalLinks,
        indexed: baseline.totalLinks - baseline.skippedLinks,
        skipped: baseline.skippedLinks,
        currentSkipped: current.skippedLinks,
    }
    let status
    if (baseline.skippedLinks && !baseline.index.size) status = 'UNPROVEN'
    else if (missingTotal) status = 'SYMBOLS_MISSING'
    else if (lostTotal) status = 'CALLERS_LOST'
    else if (warnings.length || baseline.skippedLinks) status = 'CONSERVED_WITH_WARNINGS'
    else status = 'CONSERVED'
    if (baseline.skippedLinks && warnings.length < MAX_REPORTED) {
        warnings.push({kind: 'INCOMPLETE_BASELINE_INDEX', detail: `${baseline.skippedLinks} baseline edge(s) could not be identified and were not checked`})
    }
    return {
        status,
        blockers: missingTotal + lostTotal,
        missingSymbols,
        symbols,
        warnings,
        checked: baseline.index.size,
        coverage,
        note: 'symbols and callers are matched by (file, bare name, edge type) with declared renames/moves applied, so line-shift id churn never reports false losses; a lost caller is evidence the refactor broke a call site or the graph must be rebuilt',
    }
}
