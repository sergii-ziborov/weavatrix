// Behavioral architecture evidence from bounded, local git history.
import {analyzeGitHistory, formatGitHistoryAnalytics} from '../analysis/git-history.js'
import {toolResult} from './tool-result.mjs'

export async function tGitHistory(g, args, ctx) {
    if (!ctx?.repoRoot) return toolResult('Git history intelligence is unavailable: no repository root is active.', {status: 'unavailable'})
    const result = await analyzeGitHistory({
        repoRoot: ctx.repoRoot,
        graph: g,
        months: args.months,
        maxCommits: args.max_commits,
        maxPairs: args.max_pairs,
        minPairCount: args.min_pair_count,
    })
    return toolResult(formatGitHistoryAnalytics(result, {topN: args.top_n}), result, {
        completeness: {
            status: result.status,
            complete: result.completeness?.complete === true,
            reasons: result.completeness?.reasons || [],
        },
    })
}
