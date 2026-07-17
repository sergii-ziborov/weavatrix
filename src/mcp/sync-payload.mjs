// Versioned, explicit wire schema for sync_graph. Never forward graph.json wholesale: it is a local
// cache file and may contain future fields or attacker-injected data that are not safe to upload.
import {sanitizeEvidenceSnapshot} from './sync-evidence.mjs';
import {edgeProvenance} from '../graph/edge-provenance.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_PATH_FRAGMENT = /(?:^|[\/\s"'`(=])[a-z]:[\\/]|(?:^|[\s"'`(=])(?:\\\\[^\\/\s]+(?:[\\/]|$)|file:(?:\/\/)?[\\/]|\/(?!\/)[^\s])/i;

export const MAX_SYNC_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_SYNC_NODES = 25_000;
export const MAX_SYNC_LINKS = 100_000;
export const MAX_SYNC_EXTERNAL_IMPORTS = 50_000;

function metadataString(value, max = 4096) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value)
        ? value
        : undefined;
}

// graph.json is derived data and may be edited independently of the repository. Never trust a path
// merely because it occupies an allowlisted field: sync only accepts canonical-looking repo-relative
// paths, on every host OS. Graph IDs append `#symbol@line`, so validate their file portion separately
// while preserving the complete ID on the wire.
function repoRelativePathString(value, max = 4096) {
    const path = metadataString(value, max);
    if (!path) return undefined;
    if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(path)) return undefined; // URI, drive path, POSIX or UNC absolute
    const segments = path.split(/[\\/]/);
    if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;
    return path;
}

function graphIdString(value) {
    const id = metadataString(value);
    if (!id) return undefined;
    const hash = id.indexOf('#');
    const file = hash < 0 ? id : id.slice(0, hash);
    return repoRelativePathString(file) ? id : undefined;
}

// Optional display metadata is still attacker-controlled graph data. Keep useful labels/import
// specifiers, but never let an absolute host path hide inside one of those free-text fields.
function privacySafeText(value, max = 4096) {
    const text = metadataString(value, max);
    if (!text) return undefined;
    return ABSOLUTE_PATH_FRAGMENT.test(text) ? undefined : text;
}

function repoPathV3(value, max = 4096) {
    const path = repoRelativePathString(value, max);
    return path ? path.replace(/\\/g, '/') : undefined;
}

function graphIdV3(value) {
    const id = metadataString(value);
    if (!id) return undefined;
    const hash = id.indexOf('#');
    const file = hash < 0 ? id : id.slice(0, hash);
    const safeFile = repoPathV3(file);
    if (!safeFile) return undefined;
    if (hash < 0) return safeFile;
    const suffix = id.slice(hash);
    // Builder IDs are `#symbol@line` (optionally with a short collision suffix). A symbol suffix
    // never needs a path separator or whitespace; rejecting both closes an otherwise opaque channel.
    if (suffix.length > 512 || !/^#[^\\/\s\u0000-\u001f\u007f]{1,511}$/u.test(suffix)) return undefined;
    return `${safeFile}${suffix}`;
}

function safeToken(value, max = 256) {
    const token = metadataString(value, max);
    if (!token || !/^[\p{L}\p{N}_.:@+\-#$<>()\[\],]+$/u.test(token)) return undefined;
    return token;
}

function packageName(value) {
    const name = metadataString(value, 256);
    return name && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : undefined;
}

function externalSpecifier(value) {
    const spec = metadataString(value, 512);
    if (!spec || ABSOLUTE_PATH_FRAGMENT.test(spec) || /^(?:[a-z]:[\\/]|[\\/]|\.\.?[\\/])/i.test(spec)) return undefined;
    return /^[a-z0-9@][a-z0-9@._:/+\-]*$/i.test(spec) ? spec : undefined;
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
    'linearOps', 'allocationsInLoops', 'copiesInLoops', 'linearOpsInLoops',
    'sortsInLoops', 'recursionInLoops', 'timeRank', 'timeScore', 'memoryRank', 'memoryScore',
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
    const id = graphIdString(value.id);
    if (!id) return null;
    const out = {id};
    setIf(out, 'label', metadataString(value.label, 1024));
    setIf(out, 'file_type', metadataString(value.file_type, 32));
    setIf(out, 'source_file', repoRelativePathString(value.source_file));
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
    const source = graphIdString(value.source);
    const target = graphIdString(value.target);
    if (!source || !target) return null;
    const out = {source, target};
    setIf(out, 'relation', metadataString(value.relation, 32));
    setIf(out, 'confidence', metadataString(value.confidence, 32));
    if (value.typeOnly === true) out.typeOnly = true;
    if (value.compileOnly === true) out.compileOnly = true;
    const line = finiteNumber(value.line);
    if (line !== undefined && Number.isInteger(line) && line >= 0) out.line = line;
    setIf(out, 'specifier', metadataString(value.specifier));
    return out;
}

function sanitizeExternalImport(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const file = repoRelativePathString(value.file);
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

function sanitizeNodeV3(value) {
    const out = sanitizeNode(value);
    if (!out) return null;
    const id = graphIdV3(value.id);
    if (!id) return null;
    const sourceFile = value.source_file == null ? undefined : repoPathV3(value.source_file);
    if (value.source_file != null && !sourceFile) return null;
    const hash = id.indexOf('#');
    const idFile = hash < 0 ? id : id.slice(0, hash);
    if (sourceFile && idFile !== sourceFile) return null;
    out.id = id;
    const label = privacySafeText(value.label, 1024);
    if (label) out.label = label;
    else delete out.label;
    const fileType = safeToken(value.file_type, 32);
    if (fileType) out.file_type = fileType;
    else delete out.file_type;
    if (sourceFile) out.source_file = sourceFile;
    else delete out.source_file;
    for (const key of ['symbol_kind', 'symbol_space', 'member_of', 'visibility']) setIf(out, key, safeToken(value[key], 128));
    if (out.complexity) {
        for (const key of ['family', 'scope', 'complexityScope', 'confidence']) {
            const safe = safeToken(value.complexity?.[key], 32);
            if (safe) out.complexity[key] = safe;
            else delete out.complexity[key];
        }
    }
    return out;
}

function sanitizeLinkV3(value) {
    const out = sanitizeLink(value);
    if (!out) return null;
    const source = graphIdV3(value.source);
    const target = graphIdV3(value.target);
    if (!source || !target) return null;
    out.source = source;
    out.target = target;
    for (const key of ['relation', 'confidence']) {
        const safe = safeToken(value[key], 32);
        if (safe) out[key] = safe;
        else delete out[key];
    }
    const provenance = edgeProvenance(value);
    if (provenance !== 'UNKNOWN') out.provenance = provenance;
    const specifier = privacySafeText(value.specifier, 1024);
    if (specifier) out.specifier = specifier;
    else delete out.specifier;
    return out;
}

function sanitizeExternalImportV3(value) {
    const out = sanitizeExternalImport(value);
    if (!out) return null;
    const file = repoPathV3(value.file);
    if (!file) return null;
    out.file = file;
    setIf(out, 'spec', externalSpecifier(value.spec));
    if (!externalSpecifier(value.spec)) delete out.spec;
    setIf(out, 'pkg', packageName(value.pkg));
    if (!packageName(value.pkg)) delete out.pkg;
    for (const key of ['kind', 'ecosystem']) {
        const safe = safeToken(value[key], 64);
        if (safe) out[key] = safe;
        else delete out[key];
    }
    if (value.target != null) {
        const target = repoPathV3(value.target);
        if (target) out.target = target;
        else delete out.target;
    }
    if (value.typeOnly === true) out.typeOnly = true;
    return out;
}

function assertArrayLimit(raw, key, limit) {
    const count = Array.isArray(raw[key]) ? raw[key].length : 0;
    if (count > limit) throw new Error(`${key} has ${count} entries; maximum is ${limit}`);
}

export function createSyncPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.repoBoundaryV !== 1) {
        throw new Error('graph predates repository-boundary hardening');
    }
    if (!Number.isInteger(raw.edgeTypesV) || raw.edgeTypesV < 2) {
        throw new Error('graph predates compile-only edge metadata');
    }
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.map(sanitizeNode).filter(Boolean) : [];
    const links = Array.isArray(raw.links) ? raw.links.map(sanitizeLink).filter(Boolean) : [];
    const externalImports = Array.isArray(raw.externalImports)
        ? raw.externalImports.map(sanitizeExternalImport).filter(Boolean)
        : [];
    return {
        syncPayloadV: 2,
        repoBoundaryV: 1,
        edgeTypesV: 2,
        extImportsV: Number.isInteger(raw.extImportsV) ? raw.extImportsV : 0,
        complexityV: Number.isInteger(raw.complexityV) ? raw.complexityV : 0,
        nodes,
        links,
        externalImports,
    };
}

export function createSyncPayloadV3(raw, evidence) {
    // Reuse the v2 schema gates, but construct v3 arrays independently so the stricter path/identity
    // rules cannot change graph-only compatibility for existing endpoints.
    const base = createSyncPayload(raw);
    if (!Number.isInteger(raw.edgeProvenanceV) || raw.edgeProvenanceV < 1) {
        throw new Error('graph predates edge provenance metadata');
    }
    assertArrayLimit(raw, 'nodes', MAX_SYNC_NODES);
    assertArrayLimit(raw, 'links', MAX_SYNC_LINKS);
    assertArrayLimit(raw, 'externalImports', MAX_SYNC_EXTERNAL_IMPORTS);
    const nodes = (raw.nodes || []).map(sanitizeNodeV3).filter(Boolean);
    const nodeIds = new Set();
    for (const node of nodes) {
        if (nodeIds.has(node.id)) throw new Error(`duplicate node id in graph: ${node.id}`);
        nodeIds.add(node.id);
    }
    const links = (raw.links || []).map(sanitizeLinkV3).filter(Boolean);
    for (const link of links) {
        if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) {
            throw new Error(`dangling link in graph: ${link.source} -> ${link.target}`);
        }
    }
    const externalImports = (raw.externalImports || []).map(sanitizeExternalImportV3).filter(Boolean);
    return {
        syncPayloadV: 3,
        repoBoundaryV: base.repoBoundaryV,
        edgeTypesV: base.edgeTypesV,
        edgeProvenanceV: Number.isInteger(raw.edgeProvenanceV) ? raw.edgeProvenanceV : 0,
        extImportsV: base.extImportsV,
        complexityV: base.complexityV,
        evidenceV: 1,
        nodes,
        links,
        externalImports,
        evidence: sanitizeEvidenceSnapshot(evidence),
    };
}
