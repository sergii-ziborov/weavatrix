// Dynamic package loaders often construct a node_modules path instead of using
// import/require, so they never become graph externalImports. Restrict this
// fallback to executable npm source: manifests merely declare every dependency
// and must never count as usage evidence.
const NPM_SOURCE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i
const escRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentioned = (blob, name) => new RegExp(`(^|[^\\w@.-])${escRe(name)}($|[^\\w.-])`).test(blob)

export function createPackageSourceMatcher(sourceTexts = new Map()) {
    const blob = [...sourceTexts]
        .filter(([file]) => NPM_SOURCE_RE.test(String(file || '')))
        .map(([, text]) => String(text || ''))
        .join('\n')
    return (name) => {
        if (mentioned(blob, name)) return true
        if (!name.startsWith('@') || !name.includes('/')) return false
        const [namespace, base] = name.split('/', 2)
        // join(root, "node_modules", "@scope", "package", ...)
        return new RegExp(`["'\x60]${escRe(namespace)}["'\x60][\\s\\S]{0,96}?["'\x60]${escRe(base)}["'\x60]`).test(blob)
    }
}
