import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { extname, join, relative } from 'node:path'

const SEARCH_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', '.venv', 'venv', 'env', 'target', '__pycache__', '.idea', '.vscode', '.cache', 'bin', 'obj', 'weavatrix-graphs'])
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.wasm', '.class', '.jar', '.node', '.bin'])
const MAX_SEARCH_FILE_BYTES = 1024 * 1024

function rgSearch(repoRoot, resolveRg, query, { isRegex, glob, maxResults }) {
    const rg = resolveRg()
    if (!rg) return null
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '400', '-m', '30', '-i']
    if (!isRegex) args.push('--fixed-strings')
    if (glob) args.push('-g', glob)
    args.push('--', query, repoRoot)
    const res = spawnSync(rg, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 })
    if (res.status !== 0 && res.status !== 1) return null
    const out = []
    for (const line of (res.stdout || '').split(/\r?\n/)) {
        const match = line.match(/^(.*?):(\d+):(.*)$/)
        if (!match) continue
        out.push({
            file: relative(repoRoot, match[1]).replace(/\\/g, '/'),
            line: Number(match[2]),
            text: match[3].trim().slice(0, 300),
        })
        if (out.length >= maxResults) break
    }
    return out
}

function globToRe(glob) {
    if (!glob) return null
    try {
        return new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
    } catch {
        return null
    }
}

function nodeGrep(repoRoot, query, { isRegex, glob, maxResults }) {
    const out = []
    let re = null
    if (isRegex) {
        try { re = new RegExp(query, 'i') } catch { return out }
    }
    const q = String(query).toLowerCase()
    const globRe = globToRe(glob)
    const stack = [repoRoot]
    let filesScanned = 0
    while (stack.length && out.length < maxResults) {
        const dir = stack.pop()
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
        for (const ent of entries) {
            if (out.length >= maxResults) break
            const full = join(dir, ent.name)
            if (ent.isDirectory()) {
                if (!SEARCH_SKIP.has(ent.name)) stack.push(full)
                continue
            }
            if (!ent.isFile() || BINARY_EXT.has(extname(ent.name).toLowerCase())) continue
            const rel = relative(repoRoot, full).replace(/\\/g, '/')
            if (globRe && !globRe.test(rel)) continue
            let st
            try { st = statSync(full) } catch { continue }
            if (st.size > MAX_SEARCH_FILE_BYTES) continue
            if (++filesScanned > 20000) return out
            let text
            try { text = readFileSync(full, 'utf8') } catch { continue }
            if (text.indexOf('\0') >= 0) continue
            const lines = text.split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i]
                if (re ? re.test(ln) : ln.toLowerCase().includes(q)) {
                    out.push({ file: rel, line: i + 1, text: ln.trim().slice(0, 300) })
                    if (out.length >= maxResults) break
                }
            }
        }
    }
    return out
}

export function searchCode({ repoRoot, resolveRg }, { query, is_regex = false, max_results = 40, glob } = {}) {
    if (!query) return 'Provide a "query" string.'
    if (!repoRoot || !existsSync(repoRoot)) return 'Source search unavailable: repo root not provided to this MCP server.'
    const max = Math.max(1, Math.min(200, Number(max_results) || 40))
    const opts = { isRegex: !!is_regex, glob: glob || null, maxResults: max }
    let matches = rgSearch(repoRoot, resolveRg, query, opts)
    const engine = matches ? 'ripgrep' : 'node'
    if (!matches) matches = nodeGrep(repoRoot, query, opts)
    const what = is_regex ? `/${query}/i` : `"${query}"`
    if (!matches.length) return `No matches for ${what}${glob ? ` in ${glob}` : ''}.`
    return [
        `${matches.length} match${matches.length === 1 ? '' : 'es'} for ${what}${glob ? ` (glob ${glob})` : ''} [${engine}]:`,
        ...matches.map((m) => `  ${m.file}:${m.line}:  ${m.text}`),
    ].join('\n')
}

export function readSource({ repoRoot, resolveNode, isSymbol }, g, { label, path, start_line, before = 3, after = 40 } = {}) {
    if (!repoRoot || !existsSync(repoRoot)) return 'Source read unavailable: repo root not provided to this MCP server.'
    let file = null
    let focusLine = null
    let title
    // label resolves first; a path alongside it narrows rather than overrides — the node's focus line
    // survives when both point at the same file (label+path used to silently return the file head).
    const n = label && g ? resolveNode(g, label) : null
    if (n) {
        const nodeFile = String(n.source_file || (isSymbol(n.id) ? String(n.id).split('#')[0] : n.id))
        if (!path || nodeFile.replace(/\\/g, '/') === String(path).replace(/\\/g, '/')) {
            file = nodeFile
            const match = String(n.source_location || '').match(/L(\d+)/)
            focusLine = match ? Number(match[1]) : null
            title = `${n.label ?? n.id}  [${n.id}]`
        }
    }
    if (!file) {
        if (!path) return label ? `No node found matching "${label}".` : 'Provide "label" or "path".'
        file = String(path)
        title = file
    }
    // explicit anchor wins: window = start_line-before .. start_line+after (how a path read escapes the file head)
    if (start_line != null && Number(start_line) > 0) focusLine = Math.floor(Number(start_line))
    const abs = join(repoRoot, file)
    if (!existsSync(abs)) return `File not found: ${file}`
    let text
    try { text = readFileSync(abs, 'utf8') } catch (e) { return `Could not read ${file}: ${e.message}` }
    const lines = text.split(/\r?\n/)
    if (focusLine) focusLine = Math.min(focusLine, lines.length) // an anchor past EOF shows the tail, not nothing
    const b = Math.max(0, Number(before) || 0)
    const a = Math.max(1, Number(after) || 40)
    const start = focusLine ? Math.max(1, focusLine - b) : 1
    const end = focusLine ? Math.min(lines.length, focusLine + a) : Math.min(lines.length, 1 + b + a)
    const width = String(end).length
    const body = []
    for (let i = start; i <= end; i++) body.push(`${focusLine === i ? '>' : ' '}${String(i).padStart(width)}  ${lines[i - 1] ?? ''}`)
    return [`Source: ${title}`, `${file}  (lines ${start}-${end} of ${lines.length})`, '', ...body].join('\n')
}
