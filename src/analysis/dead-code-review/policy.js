import {hasPathClass} from '../../path-classification.js'

export const DEAD_CODE_CONFIDENCE_RANK = Object.freeze({high: 0, medium: 1, low: 2})
export const DYNAMIC_CODE_RE = /(?:\brequire\s*\(\s*(?!["'])|\bcreateRequire\s*\(|\b__import__\s*\(|\bimportlib\.|(?:^|[^\w.$])(?:eval|exec)\s*\()/m
const JS_DYNAMIC_IMPORT_RE = /\bimport\s*\(/
const JS_LIKE_PATH_RE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i
export const REFLECTION_CODE_RE = /(?:\b(?:Class\.forName|get(?:Declared)?Method|getattr|setattr|hasattr|Method\.Invoke|GetMethod|GetProcAddress|dlsym)\s*\(|\b(?:globals|locals)\s*\(\s*\)\s*\[|\breflect\.[A-Za-z_$][\w$]*\s*\()/i
export const normalizedReviewPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')

export function hasDynamicCode(source, file = '') {
    const text = String(source || '')
    return DYNAMIC_CODE_RE.test(text) || (JS_LIKE_PATH_RE.test(String(file)) && JS_DYNAMIC_IMPORT_RE.test(text))
}

const NON_PRODUCT_CLASSES = Object.freeze(['generated', 'mock', 'story', 'docs', 'benchmark', 'temp'])

export function deadCodePathAllowed(info, {includeTests, includeClassified}) {
    if (!includeTests && hasPathClass(info, 'test', 'e2e')) return {ok: false, bucket: 'tests'}
    if (!includeClassified && (info?.excluded || hasPathClass(info, ...NON_PRODUCT_CLASSES))) {
        return {ok: false, bucket: 'classified'}
    }
    return {ok: true}
}
