// Versioned, explicit source-free extension schema. Never forward graph.json wholesale.
import {sanitizeEvidenceSnapshot} from './sync-evidence.mjs';
import {
    MAX_SYNC_EXTERNAL_IMPORTS, MAX_SYNC_LINKS, MAX_SYNC_NODES, assertArrayLimit,
} from './sync/payload-common.mjs';
import {sanitizeExternalImport, sanitizeLink, sanitizeNode} from './sync/payload-v2.mjs';
import {sanitizeExternalImportV3, sanitizeLinkV3, sanitizeNodeV3} from './sync/payload-v3.mjs';

export {
    MAX_SYNC_BODY_BYTES, MAX_SYNC_EXTERNAL_IMPORTS, MAX_SYNC_LINKS, MAX_SYNC_NODES,
} from './sync/payload-common.mjs';

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
        ? raw.externalImports.map(sanitizeExternalImport).filter(Boolean) : [];
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
