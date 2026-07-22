// Relative-import specifier arithmetic for file moves. All paths are POSIX, repo-relative.
// The single dangerous operation in a file move is rewriting a specifier: get the extension
// or index style wrong and the import silently breaks. Every function here fails to null
// when it cannot prove the rewrite, so the caller reports UNCERTAIN rather than emit a
// wrong edit. Non-relative (bare/alias) specifiers are never rewritten — resolution of
// those is a resolver concern the file location does not determine.

const JS_TS_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i

export const isRelativeSpecifier = (specifier) => typeof specifier === 'string' && (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../'))

const dirOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')
const baseOf = (file) => (file.includes('/') ? file.slice(file.lastIndexOf('/') + 1) : file)
const extOf = (file) => {
    const base = baseOf(file)
    const dot = base.lastIndexOf('.')
    return dot > 0 ? base.slice(dot) : ''
}

// POSIX relative path from one directory to a target path (no Node path dependency so the
// result is identical on every platform and never leaks backslashes into source).
export function posixRelative(fromDir, toPath) {
    const from = fromDir ? fromDir.split('/').filter(Boolean) : []
    const to = toPath.split('/').filter(Boolean)
    let common = 0
    while (common < from.length && common < to.length && from[common] === to[common]) common += 1
    const up = from.slice(common).map(() => '..')
    const down = to.slice(common)
    const parts = [...up, ...down]
    if (!parts.length) return '.'
    const joined = parts.join('/')
    return joined.startsWith('.') ? joined : `./${joined}`
}

// True when the specifier targets a directory that resolves through an index file, i.e. the
// resolved target is `<dir>/index.<ext>` and the specifier's last segment is not that index.
function isDirectoryIndex(specifier, targetFile) {
    const targetBase = baseOf(targetFile)
    if (!/^index\.[cm]?[jt]sx?$/i.test(targetBase)) return false
    const specBase = baseOf(specifier.replace(/\/+$/, ''))
    return !/^index$/i.test(specBase) && !JS_TS_EXT_RE.test(specBase)
}

// Recomputes a relative specifier so that, resolved from `newImporterDir`, it still points at
// `targetFile`, preserving the original specifier's extension-shown / directory-index style.
// Returns {specifier} on success or {uncertain, reason} when the style cannot be proven.
export function rewriteRelativeSpecifier({specifier, targetFile, newImporterDir}) {
    if (!isRelativeSpecifier(specifier)) return {uncertain: true, reason: 'NON_RELATIVE_SPECIFIER'}
    if (!targetFile || !JS_TS_EXT_RE.test(targetFile)) return {uncertain: true, reason: 'NON_JS_TARGET'}

    if (isDirectoryIndex(specifier, targetFile)) {
        const targetDir = dirOf(targetFile)
        return {specifier: posixRelative(newImporterDir, targetDir)}
    }
    const specExt = extOf(specifier)
    const hadExtension = JS_TS_EXT_RE.test(specifier)
    // an explicit extension that does not match the target's is a resolver mapping
    // (e.g. .js specifier for a .ts file) we will not silently rewrite
    if (hadExtension && specExt.toLowerCase() !== extOf(targetFile).toLowerCase()) {
        return {uncertain: true, reason: 'EXTENSION_MAPPING'}
    }
    const targetNoExt = targetFile.slice(0, targetFile.length - extOf(targetFile).length)
    const rewritten = posixRelative(newImporterDir, hadExtension ? targetFile : targetNoExt)
    return {specifier: rewritten}
}

export {dirOf as specifierDirOf}
