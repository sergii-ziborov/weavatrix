// Public facade and bounded local collector for behavioral Git-history intelligence.
import {childProcessEnv} from '../child-env.js'
import {createRepoBoundary} from '../repo-path.js'
import {loadWeavatrixIgnore} from '../path-ignore.js'
import {buildGitHistoryAnalytics} from './git-history/analytics.js'
import {boundedGitCommand, parseGitNumstatLog} from './git-history/collector.js'
import {
    boundedHistoryInteger,
    GIT_FORMAT,
    GIT_HISTORY_V,
    normalizeGitHistoryOptions,
    utcMonthsBefore,
} from './git-history/options.js'

export {buildGitHistoryAnalytics} from './git-history/analytics.js'
export {parseGitNumstatLog} from './git-history/collector.js'
export {GIT_HISTORY_V, GIT_HISTORY_WINDOWS} from './git-history/options.js'

const unavailableResult = (window, limits, reason) => ({
    gitHistoryV: GIT_HISTORY_V,
    status: 'unavailable',
    window,
    limits,
    completeness: {complete: false, reasons: [reason]},
    totals: {
        commitsRead: 0, commitsAnalyzed: 0, oversizedCommitsSkipped: 0, files: 0,
        additions: 0, deletions: 0, churn: 0, binaryChanges: 0, ignoredFiles: 0,
        invalidPaths: 0, graphFiles: 0,
    },
    fileChurn: [],
    hotspots: [],
    coupling: {eligibleCommits: 0, totalCandidates: 0, candidatesTruncated: false, observed: [], expectedTestSource: [], hidden: []},
})

export async function analyzeGitHistory(input = {}) {
    const options = normalizeGitHistoryOptions(input)
    const now = new Date(input.now ?? Date.now())
    if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid date')
    const since = utcMonthsBefore(now, options.months)
    const window = {months: options.months, since: since.toISOString(), until: now.toISOString()}
    const limits = {
        maxCommits: options.maxCommits,
        maxFilesPerCommit: options.maxFilesPerCommit,
        maxPairs: options.maxPairs,
        minPairCount: options.minPairCount,
        maxPairCandidates: options.maxPairCandidates,
    }
    const boundary = createRepoBoundary(input.repoRoot)
    if (!boundary.root) return unavailableResult(window, limits, 'repository root is unavailable')
    const args = [
        'log', '--no-merges', '--numstat', '-z', `--format=${GIT_FORMAT}`,
        `--since=${window.since}`, `--until=${window.until}`, `--max-count=${options.maxCommits + 1}`,
        '--', '.',
    ]
    let execution
    try {
        execution = await (input.runner || boundedGitCommand)('git', args, {
            cwd: boundary.root,
            env: childProcessEnv(),
            timeoutMs: options.timeoutMs,
            maxOutputBytes: options.maxOutputBytes,
        })
    } catch (error) {
        return unavailableResult(window, limits, String(error?.message || 'git history collection failed').slice(0, 200))
    }
    if (execution.exitCode !== 0 && !execution.truncated) return unavailableResult(window, limits, 'git log failed')
    const raw = Buffer.isBuffer(execution.stdout) ? execution.stdout : Buffer.from(String(execution.stdout || ''))
    const tooLarge = raw.length > options.maxOutputBytes
    const truncated = Boolean(execution.truncated || tooLarge)
    const bounded = tooLarge ? raw.subarray(0, options.maxOutputBytes) : raw
    const parsed = parseGitNumstatLog(bounded, {
        maxFilesPerCommit: options.maxFilesPerCommit,
        ignoreRules: loadWeavatrixIgnore(boundary.root),
        dropLastIncomplete: truncated,
    })
    const commitsTruncated = parsed.length > options.maxCommits
    return buildGitHistoryAnalytics({
        commits: parsed.slice(0, options.maxCommits),
        graph: input.graph || {},
        window,
        limits,
        status: truncated || commitsTruncated ? 'partial' : 'complete',
    })
}

export function formatGitHistoryAnalytics(result, options = {}) {
    const topN = boundedHistoryInteger(options.topN, 10, 1, 50)
    if (!result || result.status === 'unavailable') {
        return `Git history intelligence: UNAVAILABLE — ${result?.completeness?.reasons?.[0] || 'history is unavailable'}`
    }
    const window = result.window
        ? `${result.window.months} months (${result.window.since.slice(0, 10)} → ${result.window.until.slice(0, 10)})`
        : 'configured window'
    const lines = [
        `Git history intelligence — ${window}`,
        `Status: ${String(result.status).toUpperCase()} · ${result.totals.commitsAnalyzed}/${result.totals.commitsRead} commits analyzed · ${result.totals.files} files · ${result.totals.churn} changed lines`,
        '',
        'Hotspots (churn percentile × graph-connectivity percentile):',
    ]
    const hotspots = result.hotspots.slice(0, topN)
    if (!hotspots.length) lines.push('- none')
    for (const item of hotspots) lines.push(`- ${item.file}: score ${item.hotspotScore.toFixed(4)} · churn ${item.churn} in ${item.commits} commits · connectivity ${item.connectivity}`)
    lines.push('', 'Hidden co-change coupling (no graph path within 2 hops):')
    const hidden = result.coupling.hidden.slice(0, topN)
    if (!hidden.length) lines.push('- none')
    for (const pair of hidden) lines.push(`- ${pair.left} ↔ ${pair.right}: ${pair.count} commits · Jaccard ${pair.jaccard.toFixed(4)} · lift ${pair.lift.toFixed(4)} · confidence ${pair.confidence.toFixed(4)}`)
    lines.push('', 'Expected test/source co-change:')
    const expected = result.coupling.expectedTestSource.slice(0, topN)
    if (!expected.length) lines.push('- none')
    for (const pair of expected) lines.push(`- ${pair.test} ↔ ${pair.source}: ${pair.count} commits · confidence ${pair.confidence.toFixed(4)}`)
    if (result.completeness.reasons.length) lines.push('', `Partial: ${result.completeness.reasons.join('; ')}.`)
    return lines.join('\n')
}

export function boundGitHistoryAnalytics(result, options = {}) {
    const topN = boundedHistoryInteger(options.topN, 10, 1, 50)
    const source = result && typeof result === 'object' ? result : {}
    const coupling = source.coupling && typeof source.coupling === 'object' ? source.coupling : {}
    const collections = {}
    const cap = (name, value) => {
        const items = Array.isArray(value) ? value : []
        const bounded = items.slice(0, topN)
        collections[name] = {total: items.length, returned: bounded.length, truncated: items.length > bounded.length}
        return bounded
    }
    const bounded = {
        ...source,
        limits: {...(source.limits || {}), topN},
        fileChurn: cap('fileChurn', source.fileChurn),
        hotspots: cap('hotspots', source.hotspots),
        coupling: {
            ...coupling,
            observed: cap('coupling.observed', coupling.observed),
            expectedTestSource: cap('coupling.expectedTestSource', coupling.expectedTestSource),
            hidden: cap('coupling.hidden', coupling.hidden),
        },
    }
    return {
        result: bounded,
        page: {limit: topN, truncated: Object.values(collections).some((entry) => entry.truncated), collections},
    }
}
