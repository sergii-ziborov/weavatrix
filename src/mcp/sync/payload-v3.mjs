import {edgeProvenance} from '../../graph/edge-provenance.js';
import {
    externalSpecifier, graphIdV3, packageName, privacySafeText, repoPathV3,
    safeToken, setIf,
} from './payload-common.mjs';
import {sanitizeExternalImport, sanitizeLink, sanitizeNode} from './payload-v2.mjs';

export function sanitizeNodeV3(value) {
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
    if (out.complexity) for (const key of ['family', 'scope', 'complexityScope', 'confidence']) {
        const safe = safeToken(value.complexity?.[key], 32);
        if (safe) out.complexity[key] = safe;
        else delete out.complexity[key];
    }
    return out;
}

export function sanitizeLinkV3(value) {
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

export function sanitizeExternalImportV3(value) {
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
