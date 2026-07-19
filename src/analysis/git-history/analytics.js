import {isTestPath} from '../../graph/graph-filter.js'
import {isStructuralRelation} from '../../graph/relations.js'
import {
    boundedHistoryInteger,
    GIT_HISTORY_DEFAULTS as DEFAULTS,
    GIT_HISTORY_HARD_CAPS as HARD_CAPS,
    GIT_HISTORY_V,
    graphEndpoint,
    roundHistoryNumber as round,
    safeHistoryPath,
} from './options.js'

function graphFilesAndAdjacency(graph = {}) {
    const byId = new Map(), files = new Set()
    for (const node of graph.nodes || []) {
        const file = safeHistoryPath(node?.source_file)
        if (!file) continue
        byId.set(String(node.id), file)
        files.add(file)
    }
    const adjacency = new Map([...files].map((file) => [file, new Set()]))
    for (const link of graph.links || []) {
        if (isStructuralRelation(link?.relation) || link?.barrelProxy === true) continue
        const left = byId.get(String(graphEndpoint(link?.source)))
        const right = byId.get(String(graphEndpoint(link?.target)))
        if (!left || !right || left === right) continue
        adjacency.get(left)?.add(right)
        adjacency.get(right)?.add(left)
    }
    return {files, adjacency}
}

function graphDistanceAtMostTwo(left, right, adjacency) {
    if (left === right) return 0
    const neighbors = adjacency.get(left)
    if (!neighbors) return null
    if (neighbors.has(right)) return 1
    for (const middle of neighbors) if (adjacency.get(middle)?.has(right)) return 2
    return null
}

function percentile(value, positiveValues) {
    if (!(value > 0) || !positiveValues.length) return 0
    let atOrBelow = 0
    for (const candidate of positiveValues) if (candidate <= value) atOrBelow++
    return round(atOrBelow / positiveValues.length)
}

const pairSort = (left, right) => right.count - left.count
    || right.confidence - left.confidence
    || right.lift - left.lift
    || left.left.localeCompare(right.left)
    || left.right.localeCompare(right.right)

const publicPair = (pair, graphDistance) => ({
    left: pair.left,
    right: pair.right,
    count: pair.count,
    jaccard: pair.jaccard,
    lift: pair.lift,
    confidence: pair.confidence,
    leftConfidence: pair.leftConfidence,
    rightConfidence: pair.rightConfidence,
    graphDistance,
})

function fileActivity(commits, graph) {
    const activity = new Map(), fileCommits = new Map()
    let additions = 0, deletions = 0, binaryChanges = 0
    for (const commit of commits) {
        const seen = new Set()
        for (const stat of commit.files) {
            if (seen.has(stat.file)) continue
            seen.add(stat.file)
            const entry = activity.get(stat.file) || {file: stat.file, commits: 0, additions: 0, deletions: 0, binaryChanges: 0}
            entry.commits++
            entry.additions += stat.additions
            entry.deletions += stat.deletions
            entry.binaryChanges += stat.binary ? 1 : 0
            activity.set(stat.file, entry)
            fileCommits.set(stat.file, (fileCommits.get(stat.file) || 0) + 1)
            additions += stat.additions
            deletions += stat.deletions
            if (stat.binary) binaryChanges++
        }
    }
    const {files: graphFiles, adjacency} = graphFilesAndAdjacency(graph)
    const raw = [...activity.values()].map((entry) => ({...entry, churn: entry.additions + entry.deletions}))
    const churnValues = raw.map((entry) => entry.churn).filter((value) => value > 0)
    const connectivityValues = [...graphFiles].map((file) => adjacency.get(file)?.size || 0).filter((value) => value > 0)
    const fileChurn = raw.map((entry) => {
        const connectivity = adjacency.get(entry.file)?.size || 0
        const churnPercentile = percentile(entry.churn, churnValues)
        const connectivityPercentile = percentile(connectivity, connectivityValues)
        return {...entry, connectivity, churnPercentile, connectivityPercentile, hotspotScore: round(Math.sqrt(churnPercentile * connectivityPercentile))}
    }).sort((a, b) => b.churn - a.churn || b.commits - a.commits || a.file.localeCompare(b.file))
    const hotspots = fileChurn.filter((entry) => entry.connectivity > 0)
        .sort((a, b) => b.hotspotScore - a.hotspotScore || b.churn - a.churn || b.connectivity - a.connectivity || a.file.localeCompare(b.file))
    return {fileCommits, graphFiles, adjacency, fileChurn, hotspots, additions, deletions, binaryChanges}
}

function coChangePairs(commits, fileCommits, limits) {
    const counts = new Map()
    let truncated = false
    for (const commit of commits) {
        const files = [...new Set(commit.files.map((entry) => entry.file))].sort()
        for (let left = 0; left < files.length; left++) for (let right = left + 1; right < files.length; right++) {
            const key = `${files[left]}\0${files[right]}`
            if (!counts.has(key) && counts.size >= limits.maxPairCandidates) { truncated = true; continue }
            counts.set(key, (counts.get(key) || 0) + 1)
        }
    }
    const pairs = []
    for (const [key, count] of counts) {
        if (count < limits.minPairCount || !commits.length) continue
        const split = key.indexOf('\0'), left = key.slice(0, split), right = key.slice(split + 1)
        const leftCount = fileCommits.get(left) || 0, rightCount = fileCommits.get(right) || 0
        const leftConfidence = count / leftCount, rightConfidence = count / rightCount
        pairs.push({
            left, right, count,
            jaccard: round(count / (leftCount + rightCount - count)),
            lift: round((count * commits.length) / (leftCount * rightCount)),
            confidence: round(Math.max(leftConfidence, rightConfidence)),
            leftConfidence: round(leftConfidence),
            rightConfidence: round(rightConfidence),
        })
    }
    return {pairs: pairs.sort(pairSort), totalCandidates: counts.size, truncated}
}

export function buildGitHistoryAnalytics({commits = [], graph = {}, window, limits = {}, status = 'complete'} = {}) {
    const maxPairs = boundedHistoryInteger(limits.maxPairs, DEFAULTS.maxPairs, 1, HARD_CAPS.maxPairs)
    const minPairCount = boundedHistoryInteger(limits.minPairCount, DEFAULTS.minPairCount, 1, 100)
    const maxPairCandidates = boundedHistoryInteger(limits.maxPairCandidates, DEFAULTS.maxPairCandidates, 100, HARD_CAPS.maxPairCandidates)
    const eligible = commits.filter((commit) => !commit.oversized && commit.files.length > 0)
    const skipped = commits.filter((commit) => commit.oversized)
    const activity = fileActivity(eligible, graph)
    const cochange = coChangePairs(eligible, activity.fileCommits, {minPairCount, maxPairCandidates})
    const observed = cochange.pairs.slice(0, maxPairs).map((pair) => publicPair(pair, graphDistanceAtMostTwo(pair.left, pair.right, activity.adjacency)))
    const expectedTestSource = cochange.pairs.filter((pair) => isTestPath(pair.left) !== isTestPath(pair.right)).slice(0, maxPairs).map((pair) => {
        const test = isTestPath(pair.left) ? pair.left : pair.right
        const source = test === pair.left ? pair.right : pair.left
        return {
            source, test, count: pair.count, jaccard: pair.jaccard, lift: pair.lift, confidence: pair.confidence,
            sourceConfidence: source === pair.left ? pair.leftConfidence : pair.rightConfidence,
            testConfidence: test === pair.left ? pair.leftConfidence : pair.rightConfidence,
            graphDistance: graphDistanceAtMostTwo(source, test, activity.adjacency),
        }
    })
    const hidden = cochange.pairs.filter((pair) => !isTestPath(pair.left) && !isTestPath(pair.right)
        && activity.graphFiles.has(pair.left) && activity.graphFiles.has(pair.right)
        && graphDistanceAtMostTwo(pair.left, pair.right, activity.adjacency) === null)
        .slice(0, maxPairs).map((pair) => publicPair(pair, null))
    const reasons = [
        skipped.length ? `${skipped.length} oversized change-set(s) excluded` : null,
        cochange.truncated ? 'co-change candidate cap reached' : null,
        status === 'partial' ? 'git output or commit window was truncated' : null,
    ].filter(Boolean)
    return {
        gitHistoryV: GIT_HISTORY_V,
        status: reasons.length ? 'partial' : status,
        window: window || null,
        limits: {maxCommits: limits.maxCommits ?? null, maxFilesPerCommit: limits.maxFilesPerCommit ?? null, maxPairs, minPairCount, maxPairCandidates},
        completeness: {complete: reasons.length === 0, reasons},
        totals: {
            commitsRead: commits.length, commitsAnalyzed: eligible.length, oversizedCommitsSkipped: skipped.length,
            files: activity.fileChurn.length, additions: activity.additions, deletions: activity.deletions,
            churn: activity.additions + activity.deletions, binaryChanges: activity.binaryChanges,
            ignoredFiles: commits.reduce((sum, commit) => sum + (commit.ignoredFiles || 0), 0),
            invalidPaths: commits.reduce((sum, commit) => sum + (commit.invalidPaths || 0), 0),
            graphFiles: activity.graphFiles.size,
        },
        fileChurn: activity.fileChurn,
        hotspots: activity.hotspots,
        coupling: {eligibleCommits: eligible.length, totalCandidates: cochange.totalCandidates, candidatesTruncated: cochange.truncated, observed, expectedTestSource, hidden},
    }
}
