// Symbol-aware git-diff classification for change_impact.
import {spawnSync} from 'node:child_process'
import {childProcessEnv} from '../child-env.js'
import {createPathClassifier} from '../path-classification.js'
import {parseZeroContextDiff} from './change-classification/diff-parser.js'
import {
    CHANGE_CLASSIFICATION_LIMITS,
    CHANGE_CLASS_RANK,
    changeLimits,
    normalizeChangePath,
    uniqueChangeSeeds,
} from './change-classification/options.js'
import {
    analyzeParsedFile,
    classifyTestSurface,
    indexChangeGraph,
    unknownChangedFile,
} from './change-classification/symbol-classifier.js'

export {parseZeroContextDiff} from './change-classification/diff-parser.js'
export {CHANGE_CLASSIFICATION_LIMITS} from './change-classification/options.js'

const VERDICT_RANK = Object.freeze({LOW: 0, MEDIUM: 1, HIGH: 2})

function runGitDiff(repoRoot, base, limits) {
    const args = ['-C', repoRoot, 'diff', '--no-ext-diff', '--find-renames', '--no-color', '--unified=0', String(base), '--']
    const result = spawnSync('git', args, {
        encoding: 'utf8', windowsHide: true, timeout: 12_000,
        maxBuffer: limits.maxDiffBytes + 1, env: childProcessEnv(),
    })
    if (result.status === 0) return {available: true, text: String(result.stdout || ''), error: null}
    const oversized = result.error?.code === 'ENOBUFS' || Buffer.byteLength(String(result.stdout || '')) > limits.maxDiffBytes
    return {
        available: false,
        text: String(result.stdout || ''),
        oversized,
        error: oversized
            ? 'git diff exceeded the byte limit'
            : String(result.stderr || result.error?.message || 'git diff unavailable').trim(),
    }
}

const validExplicitFiles = (files) => [...new Set((Array.isArray(files) ? files : [])
    .map(normalizeChangePath)
    .filter((file) => file && !file.startsWith('../') && !file.includes('/../') && !file.startsWith('-')))]
    .sort((a, b) => a.localeCompare(b))

function collectDiffInput({diffText, repoRoot, base, explicitFiles, limits}) {
    if (typeof diffText === 'string') return {source: 'provided-diff', available: true, text: diffText, reason: '', oversized: false}
    if (repoRoot && base) {
        const result = runGitDiff(repoRoot, base, limits)
        return {source: 'git-diff', available: result.available, text: result.text, reason: result.error || '', oversized: result.oversized === true}
    }
    return {
        source: 'files-only', available: false, text: '', oversized: false,
        reason: 'no unified diff was provided and no repoRoot/base pair was available',
    }
}

function classificationReasons(counts, {available, unavailableReason, truncated, includeAddedSeeds}) {
    const reasons = []
    if (!available) reasons.push(`Diff unavailable: ${unavailableReason || 'unknown error'}; using conservative file/symbol seeds.`)
    if (truncated) reasons.push('Diff exceeded a safety bound; incomplete evidence is classified HIGH/unknown.')
    if (counts.removed || counts['signature-changed']) reasons.push(`${counts.removed} removed and ${counts['signature-changed']} signature/module-surface file change(s) can break existing callers.`)
    if (counts['body-changed']) reasons.push(`${counts['body-changed']} file(s) contain mapped executable body changes.`)
    if (counts.added && !includeAddedSeeds) reasons.push(`${counts.added} purely additive file change(s) create no dependent seeds by default.`)
    if (counts['metadata-only']) reasons.push(`${counts['metadata-only']} metadata-only file change(s) create no dependent seeds.`)
    if (counts['test-only']) reasons.push(`${counts['test-only']} test-only file change(s) are labelled explicitly and create no product blast-radius seeds.`)
    if (counts.unknown) reasons.push(`${counts.unknown} file change(s) remain unknown and are seeded conservatively.`)
    if (!reasons.length) reasons.push('No changed files were present in the supplied diff.')
    return reasons
}

export function classifyChangeImpact({
    repoRoot = '', graph = {}, base = '', diffText, files = [], includeAddedSeeds = false,
    limits: requestedLimits = {},
} = {}) {
    const limits = changeLimits(requestedLimits)
    const explicitFiles = validExplicitFiles(files)
    const input = collectDiffInput({diffText, repoRoot, base, explicitFiles, limits})
    const indexed = indexChangeGraph(graph, limits)
    const pathClassifier = createPathClassifier(repoRoot)
    const parsed = input.available
        ? parseZeroContextDiff(input.text, limits)
        : {files: [], changedLines: 0, byteLength: 0, truncated: input.oversized, oversized: input.oversized, limits}
    const analyzed = parsed.files.map((file) => classifyTestSurface(analyzeParsedFile(file, indexed, {includeAddedSeeds}), pathClassifier))
    const represented = new Set(analyzed.flatMap((file) => [file.oldPath, file.newPath].filter(Boolean)))
    for (const file of explicitFiles) if (!represented.has(file)) analyzed.push(classifyTestSurface(
        unknownChangedFile(file, indexed, input.available ? 'explicitly changed file had no textual hunk' : input.reason),
        pathClassifier,
    ))
    if (!input.available && !explicitFiles.length) analyzed.push(unknownChangedFile('(diff unavailable)', indexed, input.reason))
    analyzed.sort((a, b) => a.path.localeCompare(b.path))

    const incomplete = parsed.truncated || parsed.oversized || input.oversized
    if (incomplete) for (const file of analyzed) {
        if (file.classification === 'test-only') continue
        file.classification = 'unknown'
        file.reason = 'diff was truncated/oversized; symbol-level classification is incomplete'
        const record = indexed.get(file.newPath) || indexed.get(file.oldPath)
        file.seedIds = [...new Set([record?.fileNodeId, ...(record?.symbols || []).map((symbol) => symbol.id), ...file.seedIds].filter(Boolean))].sort()
    }

    const seeds = uniqueChangeSeeds(analyzed.flatMap((file) => file.seedIds), limits.maxSeeds)
    let verdict = 'LOW'
    for (const file of analyzed) {
        const next = ['removed', 'signature-changed', 'unknown'].includes(file.classification)
            ? 'HIGH' : file.classification === 'body-changed' ? 'MEDIUM' : 'LOW'
        if (VERDICT_RANK[next] > VERDICT_RANK[verdict]) verdict = next
    }
    if (!input.available || parsed.truncated || seeds.truncated) verdict = 'HIGH'
    const counts = Object.fromEntries(Object.keys(CHANGE_CLASS_RANK)
        .map((name) => [name, analyzed.filter((file) => file.classification === name).length]))
    return {
        ok: input.available && !parsed.truncated && !seeds.truncated,
        source: input.source,
        verdict,
        reasons: classificationReasons(counts, {
            available: input.available,
            unavailableReason: input.reason,
            truncated: incomplete,
            includeAddedSeeds,
        }),
        seedIds: seeds.items,
        files: analyzed,
        summary: {
            files: analyzed.length,
            symbols: analyzed.reduce((sum, file) => sum + file.symbols.length, 0),
            counts,
            seeds: seeds.items.length,
            totalSeedsBeforeCap: seeds.total,
        },
        bounds: {...limits, diffBytes: parsed.byteLength, changedLines: parsed.changedLines, truncated: !!parsed.truncated || seeds.truncated},
    }
}
