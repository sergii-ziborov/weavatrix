import {
    finiteNumber, graphIdString, metadataString, repoRelativePathString,
    sanitizeComplexity, setIf,
} from './payload-common.mjs';

export function sanitizeNode(value) {
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
    if (value.test_surface === true) out.test_surface = true;
    setIf(out, 'complexity', sanitizeComplexity(value.complexity));
    return out;
}

export function sanitizeLink(value) {
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

export function sanitizeExternalImport(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const file = repoRelativePathString(value.file);
    if (!file) return null;
    const out = {file};
    for (const key of ['spec', 'target']) setIf(out, key, metadataString(value[key]));
    for (const key of ['pkg', 'kind', 'ecosystem']) setIf(out, key, metadataString(value[key], 256));
    const line = finiteNumber(value.line);
    if (line !== undefined && Number.isInteger(line) && line >= 0) out.line = line;
    for (const key of ['builtin', 'dynamic', 'unresolved']) if (typeof value[key] === 'boolean') out[key] = value[key];
    return out;
}
