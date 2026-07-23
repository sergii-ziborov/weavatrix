import {createHash} from 'node:crypto'
import {computeDuplicates} from '../analysis/duplicates.js'
import {
    CAPS, STATE, VERDICT, bounded, compareText, graphId, repoRelativePath,
} from './evidence-snapshot.common.mjs'
import {compareDuplicateMember} from './evidence/duplicate-member-order.mjs'

const CLONE_MIN_SIMILARITY = 80
const DIVERGENCE_MAX_SIMILARITY = 45
const MIN_TOKENS = 50
const FILTERED_CLASSES = new Set(['test', 'e2e', 'generated', 'vendored', 'mock', 'story', 'docs', 'benchmark', 'temp'])
const SAFE_SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const DUPLICATE_EVIDENCE_THRESHOLDS = Object.freeze({
    clones: Object.freeze({mode: 'renamed', minSimilarityPercent: CLONE_MIN_SIMILARITY, minTokens: MIN_TOKENS}),
    divergence: Object.freeze({
        sameName: true,
        maxSimilarityPercent: DIVERGENCE_MAX_SIMILARITY,
        minTokens: MIN_TOKENS,
        maxImplementationsPerName: 12,
    }),
})

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const positiveInteger = (value) => Number.isFinite(value) && value >= 1 ? Math.trunc(value) : undefined

function safeGraphNodeId(value, file) {
    const id = graphId(value)
    if (!id) return undefined
    const hashIndex = id.indexOf('#')
    if (hashIndex < 1 || id.slice(0, hashIndex) !== file) return undefined
    const suffix = id.slice(hashIndex)
    return /^#[^\s\\/\u0000-\u001f\u007f]{1,511}$/u.test(suffix) ? id : undefined
}

function member(fragment) {
    if (!fragment || typeof fragment !== 'object' || fragment.kind === 'string' || fragment.excluded === true) return null
    const classes = Array.isArray(fragment.classes) ? fragment.classes : []
    if (fragment.test === true || classes.some((value) => FILTERED_CLASSES.has(value))) return null
    const file = repoRelativePath(fragment.file)
    const startLine = positiveInteger(fragment.start)
    const endLine = positiveInteger(fragment.end)
    const tokens = positiveInteger(fragment.n)
    if (!file || !startLine || !endLine || endLine < startLine || !tokens || tokens < MIN_TOKENS) return null
    const out = {file, startLine, endLine, tokens}
    const nodeId = safeGraphNodeId(fragment.id, file)
    if (nodeId) out.graphNodeId = nodeId
    return out
}

function memberIdentity(value) {
    return `${value.file}\0${value.startLine}\0${value.endLine}\0${value.graphNodeId || ''}`
}

function eligibleMembers(fragments) {
    const out = new Map()
    for (let index = 0; index < fragments.length; index++) {
        const value = member(fragments[index])
        if (value) out.set(index, value)
    }
    return out
}

function cloneGroups(data, membersByIndex) {
    const parent = new Map([...membersByIndex.keys()].map((index) => [index, index]))
    const find = (index) => {
        let root = index
        while (parent.get(root) !== root) root = parent.get(root)
        while (parent.get(index) !== index) {
            const next = parent.get(index)
            parent.set(index, root)
            index = next
        }
        return root
    }
    const union = (left, right) => {
        const a = find(left), b = find(right)
        if (a !== b) parent.set(a > b ? a : b, a > b ? b : a)
    }
    const links = []
    for (const pair of Array.isArray(data?.modes?.renamed) ? data.modes.renamed : []) {
        if (!Array.isArray(pair) || pair.length < 3) continue
        const left = Number(pair[0]), right = Number(pair[1]), similarity = Number(pair[2])
        if (!Number.isInteger(left) || !Number.isInteger(right) || left === right ||
            !membersByIndex.has(left) || !membersByIndex.has(right) ||
            !Number.isFinite(similarity) || similarity < CLONE_MIN_SIMILARITY || similarity > 100) continue
        union(left, right)
        links.push({left, right, similarity: Math.trunc(similarity)})
    }

    const components = new Map()
    for (const index of membersByIndex.keys()) {
        const root = find(index)
        if (!components.has(root)) components.set(root, [])
        components.get(root).push(index)
    }

    const groups = []
    for (const indices of components.values()) {
        if (indices.length < 2) continue
        const unique = new Map()
        for (const index of indices) {
            const value = membersByIndex.get(index)
            unique.set(memberIdentity(value), value)
        }
        const members = [...unique.values()].sort(compareDuplicateMember)
        if (members.length < 2) continue
        const indexSet = new Set(indices)
        const similarities = links
            .filter((link) => indexSet.has(link.left) && indexSet.has(link.right))
            .map((link) => link.similarity)
        if (!similarities.length) continue
        const identity = members.map(memberIdentity).join('\0')
        groups.push({
            id: hash(`clone\0${identity}`),
            memberCount: members.length,
            totalTokens: members.reduce((sum, value) => sum + value.tokens, 0),
            strongestSimilarity: Math.max(...similarities),
            weakestLinkedSimilarity: Math.min(...similarities),
            membersTruncated: members.length > CAPS.duplicateMembers,
            members: members.slice(0, CAPS.duplicateMembers),
        })
    }
    return groups.sort((a, b) => b.totalTokens - a.totalTokens || b.memberCount - a.memberCount ||
        b.strongestSimilarity - a.strongestSimilarity || compareText(a.id, b.id))
}

function divergenceCandidates(data, membersByIndex) {
    const candidates = []
    for (const twin of Array.isArray(data?.nameTwins) ? data.nameTwins : []) {
        const symbol = typeof twin?.label === 'string' && SAFE_SYMBOL.test(twin.label) ? twin.label : undefined
        if (!symbol) continue
        const pairs = []
        for (const pair of Array.isArray(twin.pairs) ? twin.pairs : []) {
            const left = Number(pair?.a), right = Number(pair?.b), similarity = Number(pair?.similarity)
            const leftMember = membersByIndex.get(left), rightMember = membersByIndex.get(right)
            if (!Number.isInteger(left) || !Number.isInteger(right) || left === right || !leftMember || !rightMember ||
                leftMember.file === rightMember.file || !Number.isFinite(similarity) ||
                similarity < 0 || similarity > DIVERGENCE_MAX_SIMILARITY) continue
            const members = [leftMember, rightMember].sort(compareDuplicateMember)
            pairs.push({
                similarity: Math.trunc(similarity),
                totalTokens: members[0].tokens + members[1].tokens,
                members,
                identity: members.map(memberIdentity).join('\0'),
            })
        }
        pairs.sort((a, b) => a.similarity - b.similarity || b.totalTokens - a.totalTokens || compareText(a.identity, b.identity))
        const selected = pairs[0]
        if (!selected) continue
        candidates.push({
            id: hash(`divergence\0${symbol.toLowerCase()}\0${selected.identity}`),
            symbol,
            similarity: selected.similarity,
            totalTokens: selected.totalTokens,
            members: selected.members,
        })
    }
    return candidates.sort((a, b) => b.totalTokens - a.totalTokens || a.similarity - b.similarity ||
        compareText(a.symbol, b.symbol) || compareText(a.id, b.id))
}

function errorSection(reason = 'DUPLICATE_ANALYSIS_ERROR') {
    return {
        state: STATE.ERROR,
        verdict: VERDICT.UNKNOWN,
        thresholds: DUPLICATE_EVIDENCE_THRESHOLDS,
        completeness: {
            fragments: {total: 0, eligible: 0, filtered: 0},
            cloneGroups: {total: 0, returned: 0, truncated: false},
            divergenceCandidates: {total: 0, returned: 0, truncated: false},
            reasons: [reason],
        },
        cloneGroups: [],
        divergenceCandidates: [],
    }
}

export function buildDuplicatesSection(repoRoot, graph) {
    try {
        const data = computeDuplicates(repoRoot, graph, {nameTwins: true, includeStrings: false})
        if (!data?.ok || !Array.isArray(data.frags)) return errorSection()
        const membersByIndex = eligibleMembers(data.frags)
        const groups = bounded(cloneGroups(data, membersByIndex), CAPS.duplicateGroups)
        const divergence = bounded(divergenceCandidates(data, membersByIndex), CAPS.divergenceCandidates)
        const reasons = []
        if (!Number.isFinite(data.graphSymbols) || data.graphSymbols < 1) reasons.push('NO_GRAPH_SYMBOLS')
        if (data.completeness?.assetFiles?.truncated) reasons.push('ASSET_SCAN_TRUNCATED')
        if (data.completeness?.nameTwinsTruncated) reasons.push('NAME_TWIN_SCAN_TRUNCATED')
        if (groups.items.some((group) => group.membersTruncated)) reasons.push('CLONE_MEMBERS_TRUNCATED')
        if (groups.completeness.truncated) reasons.push('CLONE_GROUPS_TRUNCATED')
        if (divergence.completeness.truncated) reasons.push('DIVERGENCE_CANDIDATES_TRUNCATED')
        return {
            state: reasons.length ? STATE.PARTIAL : STATE.COMPLETE,
            verdict: VERDICT.UNKNOWN,
            thresholds: DUPLICATE_EVIDENCE_THRESHOLDS,
            completeness: {
                fragments: {
                    total: data.frags.length,
                    eligible: membersByIndex.size,
                    filtered: data.frags.length - membersByIndex.size,
                },
                cloneGroups: groups.completeness,
                divergenceCandidates: divergence.completeness,
                reasons,
            },
            cloneGroups: groups.items,
            divergenceCandidates: divergence.items,
        }
    } catch {
        return errorSection()
    }
}
