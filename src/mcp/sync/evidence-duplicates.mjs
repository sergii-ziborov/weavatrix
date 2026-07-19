import {
    CAPS, DUPLICATE_THRESHOLDS, bool, compare, count, graphId, int, list,
    path, reasons, state, text, verdict,
} from './evidence-common.mjs'

function duplicateEvidenceId(value) {
    const id = text(value, 64)
    return id && /^[a-f0-9]{24,64}$/i.test(id) ? id : undefined
}

function duplicateMember(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const file = path(value.file)
    const startLine = int(value.startLine), endLine = int(value.endLine), tokens = int(value.tokens)
    if (!file || startLine < 1 || endLine < startLine || tokens < DUPLICATE_THRESHOLDS.clones.minTokens) return null
    const out = {file, startLine, endLine, tokens}
    const nodeId = graphId(value.graphNodeId)
    if (nodeId?.startsWith(`${file}#`)) out.graphNodeId = nodeId
    return out
}

function compareDuplicateMember(a, b) {
    return compare(a.file, b.file) || a.startLine - b.startLine || a.endLine - b.endLine || compare(a.graphNodeId || '', b.graphNodeId || '')
}

function duplicateMembers(values, cap = CAPS.duplicateMembers) {
    const raw = Array.isArray(values) ? values : []
    const unique = new Map()
    for (const value of raw) {
        const item = duplicateMember(value)
        if (!item) continue
        unique.set(`${item.file}\0${item.startLine}\0${item.endLine}\0${item.graphNodeId || ''}`, item)
    }
    const all = [...unique.values()].sort(compareDuplicateMember)
    return {items: all.slice(0, cap), total: all.length, invalid: raw.length - all.length, truncated: all.length > cap}
}

function cloneGroup(value) {
    const id = duplicateEvidenceId(value?.id)
    const members = duplicateMembers(value?.members)
    const rawStrongestSimilarity = Number(value?.strongestSimilarity)
    const rawWeakestLinkedSimilarity = Number(value?.weakestLinkedSimilarity)
    const strongestSimilarity = Math.trunc(rawStrongestSimilarity)
    const weakestLinkedSimilarity = Math.trunc(rawWeakestLinkedSimilarity)
    if (!id || members.items.length < 2 || strongestSimilarity < DUPLICATE_THRESHOLDS.clones.minSimilarityPercent ||
        !Number.isFinite(rawStrongestSimilarity) || rawStrongestSimilarity > 100 ||
        !Number.isFinite(rawWeakestLinkedSimilarity) || weakestLinkedSimilarity < DUPLICATE_THRESHOLDS.clones.minSimilarityPercent ||
        rawWeakestLinkedSimilarity > 100 || weakestLinkedSimilarity > strongestSimilarity) return null
    const memberCount = Math.max(int(value?.memberCount), members.total)
    const returnedTokens = members.items.reduce((sum, member) => sum + member.tokens, 0)
    return {
        id, memberCount, totalTokens: Math.max(int(value?.totalTokens), returnedTokens),
        strongestSimilarity, weakestLinkedSimilarity,
        membersTruncated: bool(value?.membersTruncated) || members.truncated || members.invalid > 0 || memberCount > members.items.length,
        members: members.items,
    }
}

function divergenceCandidate(value) {
    const id = duplicateEvidenceId(value?.id)
    const symbol = text(value?.symbol, 256)
    const rawSimilarity = Number(value?.similarity)
    const similarity = Math.trunc(rawSimilarity)
    const members = duplicateMembers(value?.members, 2)
    if (!id || !symbol || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol) || members.total !== 2 || members.invalid > 0 ||
        !Number.isFinite(rawSimilarity) || rawSimilarity < 0 || rawSimilarity > DUPLICATE_THRESHOLDS.divergence.maxSimilarityPercent ||
        members.items[0].file === members.items[1].file) return null
    return {id, symbol, similarity, totalTokens: Math.max(int(value?.totalTokens), members.items[0].tokens + members.items[1].tokens), members: members.items}
}

export function sanitizeDuplicates(value) {
    const rawGroups = Array.isArray(value?.cloneGroups) ? value.cloneGroups : []
    const rawDivergence = Array.isArray(value?.divergenceCandidates) ? value.divergenceCandidates : []
    const cloneGroups = list(rawGroups, CAPS.duplicateGroups, cloneGroup,
        (a, b) => b.totalTokens - a.totalTokens || b.memberCount - a.memberCount || compare(a.id, b.id))
    const divergence = list(rawDivergence, CAPS.divergenceCandidates, divergenceCandidate,
        (a, b) => b.totalTokens - a.totalTokens || a.similarity - b.similarity || compare(a.symbol, b.symbol) || compare(a.id, b.id))
    const invalid = rawGroups.length - cloneGroups.total + rawDivergence.length - divergence.total
    const membersTruncated = cloneGroups.items.some((group) => group.membersTruncated)
    const groupCompleteness = count(value?.completeness?.cloneGroups, rawGroups.length, cloneGroups.items.length)
    const divergenceCompleteness = count(value?.completeness?.divergenceCandidates, rawDivergence.length, divergence.items.length)
    const truncated = cloneGroups.truncated || divergence.truncated || groupCompleteness.truncated || divergenceCompleteness.truncated || membersTruncated || invalid > 0
    const outReasons = reasons([
        ...(Array.isArray(value?.completeness?.reasons) ? value.completeness.reasons : []),
        ...(invalid > 0 ? ['INVALID_DUPLICATE_EVIDENCE_DROPPED'] : []),
        ...(membersTruncated ? ['CLONE_MEMBERS_TRUNCATED'] : []),
        ...(cloneGroups.truncated ? ['CLONE_GROUPS_TRUNCATED'] : []),
        ...(divergence.truncated ? ['DIVERGENCE_CANDIDATES_TRUNCATED'] : []),
    ])
    const rawFragments = value?.completeness?.fragments
    const eligible = int(rawFragments?.eligible), filtered = int(rawFragments?.filtered)
    const total = Math.max(int(rawFragments?.total), eligible + filtered)
    const outState = state(value?.state)
    return {
        state: truncated && outState === 'COMPLETE' ? 'PARTIAL' : outState,
        verdict: verdict(value?.verdict), thresholds: DUPLICATE_THRESHOLDS,
        completeness: {fragments: {total, eligible: Math.min(eligible, total), filtered: Math.max(filtered, total - eligible)}, cloneGroups: groupCompleteness, divergenceCandidates: divergenceCompleteness, reasons: outReasons},
        cloneGroups: cloneGroups.items, divergenceCandidates: divergence.items,
    }
}
