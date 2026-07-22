import {createHash} from 'node:crypto'

const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 50
const DEFAULT_RELATED_LIMIT = 5
const MAX_RELATED_LIMIT = 25

export class ContractCursorError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ContractCursorError'
        this.code = 'INVALID_CURSOR'
    }
}

const boundedInteger = (value, fallback, minimum, maximum) => {
    const parsed = Number(value)
    return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
}

const pageFingerprint = (parts) => createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 24)

const encodeCursor = (fingerprint, offset) => Buffer
    .from(JSON.stringify({v: 1, fingerprint, offset}), 'utf8')
    .toString('base64url')

function decodeCursor(raw, fingerprint, total) {
    if (!raw) return 0
    try {
        const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
        if (parsed?.v !== 1 || parsed.fingerprint !== fingerprint) {
            throw new ContractCursorError('cursor does not belong to this repository revision and filter set')
        }
        if (!Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > total) {
            throw new ContractCursorError('cursor offset is outside the available evidence')
        }
        return parsed.offset
    } catch (error) {
        if (error instanceof ContractCursorError) throw error
        throw new ContractCursorError('cursor is malformed')
    }
}

const sample = (items, limit) => ({
    total: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items.slice(0, limit) : [],
    truncated: Array.isArray(items) && items.length > limit,
})

function compactEndpoint(endpoint, relatedLimit) {
    const affected = endpoint?.affected || {}
    return {
        kind: 'http-endpoint',
        backend: endpoint.backend,
        method: endpoint.method,
        path: endpoint.path,
        normalizedPath: endpoint.normalizedPath,
        handler: endpoint.handler,
        handlerNodeId: endpoint.handlerNodeId,
        handlerResolution: endpoint.handlerResolution,
        file: endpoint.file,
        line: endpoint.line,
        callsites: sample(endpoint.callsites, relatedLimit),
        methodMismatches: endpoint.methodMismatches,
        methodMismatchSites: sample(endpoint.methodMismatchSites, relatedLimit),
        liveness: endpoint.liveness,
        affected: {
            complete: affected.complete === true,
            files: sample(affected.files, relatedLimit),
            screens: sample(affected.screens, relatedLimit),
            modules: sample(affected.modules, relatedLimit),
            traversalTruncated: affected.truncated || {},
        },
    }
}

function compactTransport(contract, relatedLimit) {
    const affected = contract?.affected || {}
    return {
        kind: 'transport-contract',
        transport: contract.transport,
        side: contract.side,
        service: contract.service,
        operation: contract.operation,
        name: contract.name,
        file: contract.file,
        line: contract.line,
        detector: contract.detector,
        liveness: contract.liveness,
        runtimeObserved: contract.runtimeObserved === true,
        callsites: sample(contract.callsites, relatedLimit),
        affected: {
            complete: affected.complete === true,
            files: sample(affected.files, relatedLimit),
            screens: sample(affected.screens, relatedLimit),
            modules: sample(affected.modules, relatedLimit),
            traversalTruncated: affected.truncated || {},
        },
    }
}

function evidenceItems(analysis, transportAnalysis) {
    return [
        ...(analysis.endpoints || []).map((value) => ({kind: 'http-endpoint', value})),
        ...(transportAnalysis.contracts || []).map((value) => ({kind: 'transport-contract', value})),
        ...(analysis.uncertain || []).map((value) => ({kind: 'http-uncertain', value})),
        ...(transportAnalysis.uncertain || []).map((value) => ({kind: 'transport-uncertain', value})),
    ]
}

function projectItem(item, detail, relatedLimit) {
    if (detail === 'full') return {kind: item.kind, ...item.value}
    if (item.kind === 'http-endpoint') return compactEndpoint(item.value, relatedLimit)
    if (item.kind === 'transport-contract') return compactTransport(item.value, relatedLimit)
    return {kind: item.kind, ...item.value}
}

export function paginateContractEvidence({analysis, transportAnalysis, args = {}, fingerprintParts = []}) {
    const detail = args.response_detail === 'full' ? 'full' : 'compact'
    const pageSize = boundedInteger(args.page_size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
    const relatedLimit = boundedInteger(args.per_item_limit, DEFAULT_RELATED_LIMIT, 1, MAX_RELATED_LIMIT)
    const all = evidenceItems(analysis, transportAnalysis)
    const fingerprint = pageFingerprint(fingerprintParts)
    const offset = decodeCursor(args.cursor, fingerprint, all.length)
    const selected = all.slice(offset, offset + pageSize)
    const nextOffset = offset + selected.length
    const nextCursor = nextOffset < all.length ? encodeCursor(fingerprint, nextOffset) : null
    return {
        detail,
        offset,
        pageSize,
        perItemLimit: detail === 'compact' ? relatedLimit : null,
        totalItems: all.length,
        returnedItems: selected.length,
        hasMore: nextCursor !== null,
        nextCursor,
        items: selected.map((item) => projectItem(item, detail, relatedLimit)),
    }
}
