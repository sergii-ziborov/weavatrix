// Versioned, explicit wire schema for sync_graph. Never forward graph.json wholesale: it is a local
// cache file and may contain future fields or attacker-injected data that are not safe to upload.

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function metadataString(value, max = 4096) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value)
        ? value
        : undefined;
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function setIf(out, key, value) {
    if (value !== undefined) out[key] = value;
}

const COMPLEXITY_NUMBERS = [
    'startLine', 'endLine', 'loc', 'params', 'objectFields', 'branches', 'cyclomatic',
    'loops', 'maxLoopDepth', 'returns', 'awaits', 'callCount', 'externalCalls',
    'asyncBoundaries', 'allocations', 'objectLiterals', 'spreadCopies', 'sorts',
    'linearOps', 'timeRank', 'timeScore', 'memoryRank', 'memoryScore',
];

function sanitizeComplexity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const key of COMPLEXITY_NUMBERS) setIf(out, key, finiteNumber(value[key]));
    if (typeof value.recursion === 'boolean') out.recursion = value.recursion;
    for (const key of ['family', 'scope', 'complexityScope', 'confidence']) {
        setIf(out, key, metadataString(value[key], 32));
    }
    return Object.keys(out).length ? out : undefined;
}

function sanitizeNode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = metadataString(value.id);
    if (!id) return null;
    const out = {id};
    setIf(out, 'label', metadataString(value.label, 1024));
    setIf(out, 'file_type', metadataString(value.file_type, 32));
    setIf(out, 'source_file', metadataString(value.source_file));
    const sourceLocation = metadataString(value.source_location, 32);
    const sourceEnd = metadataString(value.source_end, 32);
    if (sourceLocation && /^L\d+$/.test(sourceLocation)) out.source_location = sourceLocation;
    if (sourceEnd && /^L\d+$/.test(sourceEnd)) out.source_end = sourceEnd;
    const community = finiteNumber(value.community);
    if (community !== undefined && Number.isInteger(community) && community >= 0) out.community = community;
    if (typeof value.exported === 'boolean') out.exported = value.exported;
    if (typeof value.decorated === 'boolean') out.decorated = value.decorated;
    setIf(out, 'complexity', sanitizeComplexity(value.complexity));
    return out;
}

function sanitizeLink(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = metadataString(value.source);
    const target = metadataString(value.target);
    if (!source || !target) return null;
    const out = {source, target};
    setIf(out, 'relation', metadataString(value.relation, 32));
    setIf(out, 'confidence', metadataString(value.confidence, 32));
    return out;
}

function sanitizeExternalImport(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const file = metadataString(value.file);
    if (!file) return null;
    const out = {file};
    for (const key of ['spec', 'target']) setIf(out, key, metadataString(value[key]));
    for (const key of ['pkg', 'kind', 'ecosystem']) setIf(out, key, metadataString(value[key], 256));
    const line = finiteNumber(value.line);
    if (line !== undefined && Number.isInteger(line) && line >= 0) out.line = line;
    for (const key of ['builtin', 'dynamic', 'unresolved']) {
        if (typeof value[key] === 'boolean') out[key] = value[key];
    }
    return out;
}

export function createSyncPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.repoBoundaryV !== 1) {
        throw new Error('graph predates repository-boundary hardening');
    }
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.map(sanitizeNode).filter(Boolean) : [];
    const links = Array.isArray(raw.links) ? raw.links.map(sanitizeLink).filter(Boolean) : [];
    const externalImports = Array.isArray(raw.externalImports)
        ? raw.externalImports.map(sanitizeExternalImport).filter(Boolean)
        : [];
    return {
        syncPayloadV: 1,
        repoBoundaryV: 1,
        extImportsV: Number.isInteger(raw.extImportsV) ? raw.extImportsV : 0,
        complexityV: Number.isInteger(raw.complexityV) ? raw.complexityV : 0,
        nodes,
        links,
        externalImports,
    };
}
