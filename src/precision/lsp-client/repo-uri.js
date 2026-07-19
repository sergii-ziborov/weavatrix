import {realpathSync} from 'node:fs'
import {isAbsolute, relative, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

function normalizeFilesystemPath(path) {
    let normalized = path
    if (process.platform === 'win32' && normalized.startsWith('\\\\?\\UNC\\')) normalized = `\\\\${normalized.slice(8)}`
    else if (process.platform === 'win32' && normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4)
    return resolve(normalized)
}

function realpathIfPossible(path) {
    try { return normalizeFilesystemPath(realpathSync.native(path)) }
    catch { return normalizeFilesystemPath(path) }
}

function existingRealpath(path) {
    try { return normalizeFilesystemPath(realpathSync.native(path)) }
    catch { return null }
}

function pathInside(rootPath, candidatePath) {
    const rel = relative(rootPath, candidatePath)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function portableRelative(rootPath, candidatePath) {
    return relative(rootPath, candidatePath).split(sep).join('/')
}

/** Repository-bounded path/URI conversion surface used by the client. */
export function createRepoUriNormalizer(repoRoot) {
    if (typeof repoRoot !== 'string' || repoRoot.trim() === '') throw new TypeError('repoRoot is required')
    const lexicalRoot = normalizeFilesystemPath(resolve(repoRoot))
    const absoluteRoot = realpathIfPossible(lexicalRoot)
    const toAbsolute = (filePath) => {
        if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('filePath is required')
        const lexicalPath = normalizeFilesystemPath(resolve(lexicalRoot, filePath))
        const canonicalPath = existingRealpath(lexicalPath)
        if (canonicalPath == null) {
            if (!pathInside(lexicalRoot, lexicalPath)) throw new RangeError('LSP path is outside the repository')
            return lexicalPath
        }
        if (!pathInside(absoluteRoot, canonicalPath)) throw new RangeError('LSP path resolves outside the repository')
        return canonicalPath
    }
    const fromUri = (uri) => {
        if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new RangeError('Only file: LSP URIs are accepted')
        let filePath
        try { filePath = fileURLToPath(uri) }
        catch (error) { throw new RangeError('Invalid file: LSP URI', {cause: error}) }
        const absolutePath = toAbsolute(filePath)
        return {file: portableRelative(absoluteRoot, absolutePath), absolutePath, uri: pathToFileURL(absolutePath).href}
    }
    const toUri = (filePath) => {
        const absolutePath = toAbsolute(filePath)
        return {file: portableRelative(absoluteRoot, absolutePath), absolutePath, uri: pathToFileURL(absolutePath).href}
    }
    return {rootPath: absoluteRoot, rootUri: pathToFileURL(absoluteRoot).href, toAbsolute, toUri, fromUri}
}
