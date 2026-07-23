import {computeDuplicates} from '../../analysis/duplicates.js'
import {analyzeDuplicateGroups} from '../../analysis/duplicate-groups.js'
import {toolResult} from '../tool-result.mjs'

const NON_PRODUCT_DUPLICATE_CLASSES = new Set(['generated', 'vendored', 'mock', 'story', 'docs', 'benchmark', 'temp'])
const fragmentEligible = (fragment, {tokMin, skipTests, includeClassified}) => {
    if (fragment.n < tokMin) return false
    const classes = new Set(fragment.classes || [])
    if (skipTests && (fragment.test || classes.has('test') || classes.has('e2e'))) return false
    if (!includeClassified && (fragment.excluded || [...classes].some((name) => NON_PRODUCT_DUPLICATE_CLASSES.has(name)))) return false
    return true
}

export function tFindDuplicates(g, args, ctx) {
    if (!ctx.repoRoot) return toolResult('Duplicate scan needs the repo root (not provided to this server).', {
        status: 'INVALID', groups: [], reason: 'repo root unavailable',
    }, {completeness: {status: 'PARTIAL', reason: 'repo root unavailable'}})
    const simMin = Math.min(100, Math.max(50, Number(args.min_similarity) || 80))
    const tokMin = Math.min(400, Math.max(12, Number(args.min_tokens) || 50))
    const mode = args.mode === 'strict' ? 'strict' : 'renamed'
    const skipTests = args.include_tests ? false : true
    const includeClassified = args.include_classified === true || args.include_non_product === true
    const includeStrings = !!args.include_strings
    // semantic mode: same-name symbols across files, ranked by size — LOW similarity is the signal
    // (same name, drifted behavior). Token-clone pairing is skipped entirely.
    if (args.mode === 'semantic') {
        const data = computeDuplicates(ctx.repoRoot, ctx.graphPath, {nameTwins: true, minTokens: tokMin})
        const frags = data.frags
        const candidates = []
        for (const twin of data.nameTwins || []) {
            const allowed = new Set(twin.members.filter((i) => fragmentEligible(frags[i], {tokMin, skipTests, includeClassified})))
            const pairs = (twin.pairs || []).filter((p) => allowed.has(p.a) && allowed.has(p.b))
            if (!pairs.length) continue
            const closest = pairs.slice().sort((a, b) => b.similarity - a.similarity)[0]
            const farthest = pairs.slice().sort((a, b) => a.similarity - b.similarity)[0]
            if (closest.similarity >= 85) candidates.push({kind: 'clone', label: twin.label, pair: closest})
            if (farthest.similarity <= 45) candidates.push({kind: 'collision', label: twin.label, pair: farthest})
        }
        for (const item of candidates) item.tokens = frags[item.pair.a].n + frags[item.pair.b].n
        candidates.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'clone' ? -1 : 1
            return a.kind === 'clone'
                ? b.pair.similarity - a.pair.similarity || b.tokens - a.tokens
                : b.tokens - a.tokens || a.pair.similarity - b.pair.similarity
        })
        if (!candidates.length) return toolResult(
            'No actionable same-name pairs across files (semantic mode; ambiguous middle-similarity pairs are suppressed).',
            {status: 'COMPLETE', mode: 'semantic', total: 0, groups: [], thresholds: {minTokens: tokMin}},
            {page: {shown: 0, total: 0, capped: false}, completeness: {status: 'COMPLETE'}},
        )
        const top = candidates.slice(0, Math.min(30, Math.max(1, Number(args.top_n) || 15)))
        const lines = top.map((item, k) => {
            const a = frags[item.pair.a]
            const b = frags[item.pair.b]
            const verdict = item.kind === 'clone'
                ? 'near-identical duplicate candidate — review, then extract shared logic if the contract is truly shared'
                : 'name collision, not a duplicate — inspect only if these definitions should share a contract'
            return [
                `${k + 1}. "${item.label}" — ${item.pair.similarity}% similar; ${verdict}`,
                `     ${a.file}:${a.start}-${a.end}  (${a.n} tok)`,
                `     ${b.file}:${b.start}-${b.end}  (${b.n} tok)`,
            ].join('\n')
        })
        const text = `Found ${candidates.length} actionable same-name pair(s) across files (semantic mode; one closest clone and/or farthest collision per name). Top ${top.length}:\n\n${lines.join('\n\n')}\n\nThese are review candidates, not automatic refactors. Use read_source on both sites before changing code.`
        return toolResult(text, {
            status: 'COMPLETE', mode: 'semantic', total: candidates.length, thresholds: {minTokens: tokMin},
            groups: top.map((item) => ({
                kind: item.kind, label: item.label, similarity: item.pair.similarity,
                members: [frags[item.pair.a], frags[item.pair.b]].map((fragment) => ({
                    file: fragment.file, start: fragment.start, end: fragment.end, tokens: fragment.n, label: fragment.label,
                })),
            })),
        }, {page: {shown: top.length, total: candidates.length, capped: top.length < candidates.length}, completeness: {status: 'COMPLETE'}})
    }
    const analysis = analyzeDuplicateGroups(ctx.repoRoot, ctx.graphPath, args)
    const groups = analysis.groups
    const smallPolicy = tokMin < 30 ? ' Small fragments below 30 tokens require at least 95% similarity and two shared bounded fingerprints.' : ''
    const suppressed = analysis.suppressed
    const suppressionNote = suppressed && !includeClassified
        ? ` ${suppressed} fragment(s) classified as tests/e2e/generated/vendored/mock/story/docs/benchmark/temp or matched by .weavatrix.json exclude were suppressed; pass include_classified:true (and include_tests:true for tests) to inspect them explicitly.`
        : ''
    const boilerplateNote = analysis.boilerplateSuppressed
        ? ` ${analysis.boilerplateSuppressed} all-router framework boilerplate group(s) were suppressed; pass include_boilerplate:true to inspect them.`
        : ''
    const declarativeNote = analysis.declarativeSuppressed
        ? ` ${analysis.declarativeSuppressed} immutable declarative catalog group(s) were suppressed; pass include_declarative:true to inspect repeated data shapes.`
        : ''
    if (!groups.length) return toolResult(
        `No clones at ≥${simMin}% similarity / ≥${tokMin} tokens (${mode} mode). Try lowering the thresholds.${smallPolicy}${suppressionNote}${boilerplateNote}${declarativeNote}`,
        {
            status: 'COMPLETE', mode, total: 0, groups: [], thresholds: {minSimilarity: simMin, minTokens: tokMin},
            suppressed: {classifiedFragments: suppressed, boilerplateGroups: analysis.boilerplateSuppressed, declarativeGroups: analysis.declarativeSuppressed},
        },
        {page: {shown: 0, total: 0, capped: false}, completeness: {status: 'COMPLETE'}},
    )
    const top = groups.slice(0, Math.min(30, Math.max(1, Number(args.top_n) || 15)))
    const lines = top.map((grp, k) => {
        const isStr = grp.members.some((f) => f.kind === 'string')
        const head = `${k + 1}. ${grp.members.length}× "${grp.members[0].label}"${isStr ? ' [string literal]' : ''} — ≤${grp.maxSim}% similar, ${grp.tokens} duplicated tokens`
        const sites = grp.members.slice(0, 8).map((f) => `     ${f.file}:${f.start}-${f.end}`)
        return [head, ...sites].join('\n')
    })
    const text = `Found ${groups.length} clone group(s) (${mode} mode, ≥${simMin}%, ≥${tokMin} tok${includeStrings ? ', incl. large string literals' : ''}). Top ${top.length}:\n\n${lines.join('\n\n')}\n\nUse read_source on any two sites to compare, then extract shared logic.${smallPolicy}${suppressionNote}${boilerplateNote}${declarativeNote}`
    return toolResult(text, {
        status: 'COMPLETE', mode, total: groups.length, thresholds: {minSimilarity: simMin, minTokens: tokMin},
        includeStrings,
        suppressed: {classifiedFragments: suppressed, boilerplateGroups: analysis.boilerplateSuppressed, declarativeGroups: analysis.declarativeSuppressed},
        groups: top.map((group) => ({
            similarity: group.maxSim, duplicatedTokens: group.tokens,
            members: group.members.slice(0, 8).map((fragment) => ({
                file: fragment.file, start: fragment.start, end: fragment.end, tokens: fragment.n,
                label: fragment.label, kind: fragment.kind || 'symbol', classes: fragment.classes || [],
            })),
            memberCount: group.members.length,
        })),
    }, {page: {shown: top.length, total: groups.length, capped: top.length < groups.length}, completeness: {status: 'COMPLETE'}})
}

// Focused dead-code review queue. Unlike the broad run_audit surface, this includes functions and
// methods with bounded source-free evidence, and explicitly demotes framework/dynamic/public API
// candidates. It never returns an automatic-delete verdict.
