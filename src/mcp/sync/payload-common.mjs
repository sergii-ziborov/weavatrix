const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_PATH_FRAGMENT = /(?:^|[\/\s"'`(=])[a-z]:[\\/]|(?:^|[\s"'`(=])(?:\\\\[^\\/\s]+(?:[\\/]|$)|file:(?:\/\/)?[\\/]|\/(?!\/)[^\s])/i;

export const MAX_SYNC_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_SYNC_NODES = 25_000;
export const MAX_SYNC_LINKS = 100_000;
export const MAX_SYNC_EXTERNAL_IMPORTS = 50_000;

export function metadataString(value, max = 4096) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value)
        ? value : undefined;
}

export function repoRelativePathString(value, max = 4096) {
    const path = metadataString(value, max);
    if (!path || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(path)) return undefined;
    const segments = path.split(/[\\/]/);
    if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;
    return path;
}

export function graphIdString(value) {
    const id = metadataString(value);
    if (!id) return undefined;
    const hash = id.indexOf('#');
    const file = hash < 0 ? id : id.slice(0, hash);
    return repoRelativePathString(file) ? id : undefined;
}

export function privacySafeText(value, max = 4096) {
    const text = metadataString(value, max);
    return text && !ABSOLUTE_PATH_FRAGMENT.test(text) ? text : undefined;
}

export function repoPathV3(value, max = 4096) {
    const path = repoRelativePathString(value, max);
    return path ? path.replace(/\\/g, '/') : undefined;
}

export function graphIdV3(value) {
    const id = metadataString(value);
    if (!id) return undefined;
    const hash = id.indexOf('#');
    const file = hash < 0 ? id : id.slice(0, hash);
    const safeFile = repoPathV3(file);
    if (!safeFile) return undefined;
    if (hash < 0) return safeFile;
    const suffix = id.slice(hash);
    if (suffix.length > 512 || !/^#[^\\/\s\u0000-\u001f\u007f]{1,511}$/u.test(suffix)) return undefined;
    return `${safeFile}${suffix}`;
}

export function safeToken(value, max = 256) {
    const token = metadataString(value, max);
    return token && /^[\p{L}\p{N}_.:@+\-#$<>()\[\],]+$/u.test(token) ? token : undefined;
}

export function packageName(value) {
    const name = metadataString(value, 256);
    return name && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : undefined;
}

export function externalSpecifier(value) {
    const spec = metadataString(value, 512);
    if (!spec || ABSOLUTE_PATH_FRAGMENT.test(spec) || /^(?:[a-z]:[\\/]|[\\/]|\.\.?[\\/])/i.test(spec)) return undefined;
    return /^[a-z0-9@][a-z0-9@._:/+\-]*$/i.test(spec) ? spec : undefined;
}

export function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function setIf(out, key, value) {
    if (value !== undefined) out[key] = value;
}

const COMPLEXITY_NUMBERS = [
    'startLine', 'endLine', 'loc', 'params', 'objectFields', 'branches', 'cyclomatic',
    'loops', 'maxLoopDepth', 'returns', 'awaits', 'callCount', 'externalCalls',
    'asyncBoundaries', 'allocations', 'objectLiterals', 'spreadCopies', 'sorts',
    'linearOps', 'allocationsInLoops', 'copiesInLoops', 'linearOpsInLoops',
    'sortsInLoops', 'recursionInLoops', 'timeRank', 'timeScore', 'memoryRank', 'memoryScore',
];

export function sanitizeComplexity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const key of COMPLEXITY_NUMBERS) setIf(out, key, finiteNumber(value[key]));
    if (typeof value.recursion === 'boolean') out.recursion = value.recursion;
    for (const key of ['family', 'scope', 'complexityScope', 'confidence']) setIf(out, key, metadataString(value[key], 32));
    return Object.keys(out).length ? out : undefined;
}

export function assertArrayLimit(raw, key, limit) {
    const count = Array.isArray(raw[key]) ? raw[key].length : 0;
    if (count > limit) throw new Error(`${key} has ${count} entries; maximum is ${limit}`);
}
