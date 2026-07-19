import {changeLimits, normalizeChangePath} from './options.js'

function decodeGitQuoted(value) {
    const input = String(value || '').trim()
    if (!input.startsWith('"')) return input.split('\t', 1)[0]
    try { return JSON.parse(input) } catch { /* Git octal escapes are not JSON. */ }
    const bytes = []
    for (let index = 1; index < input.length - 1; index++) {
        const char = input[index]
        if (char !== '\\') { bytes.push(...Buffer.from(char)); continue }
        const next = input[++index] || ''
        if (/[0-7]/.test(next)) {
            let octal = next
            while (octal.length < 3 && /[0-7]/.test(input[index + 1] || '')) octal += input[++index]
            bytes.push(parseInt(octal, 8))
        } else {
            const escapes = {n: 10, r: 13, t: 9, b: 8, f: 12, v: 11, '\\': 92, '"': 34}
            bytes.push(escapes[next] ?? next.charCodeAt(0))
        }
    }
    return Buffer.from(bytes).toString('utf8')
}

function diffPath(raw, prefix) {
    const decoded = decodeGitQuoted(raw)
    if (!decoded || decoded === '/dev/null') return null
    return normalizeChangePath(decoded.startsWith(`${prefix}/`) ? decoded.slice(2) : decoded)
}

function headerPaths(line) {
    const match = /^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/.exec(line)
    return match
        ? {oldPath: diffPath(match[1], 'a'), newPath: diffPath(match[2], 'b')}
        : {oldPath: null, newPath: null}
}

const emptyFile = (paths = {}) => ({
    oldPath: paths.oldPath || null,
    newPath: paths.newPath || null,
    newFile: false,
    deletedFile: false,
    renamed: false,
    binary: false,
    hunks: [],
    additions: [],
    removals: [],
})

export function parseZeroContextDiff(diffText, options = {}) {
    const limits = changeLimits(options)
    const original = String(diffText ?? '')
    const byteLength = Buffer.byteLength(original)
    const oversized = byteLength > limits.maxDiffBytes
    const text = oversized ? original.slice(0, limits.maxDiffBytes) : original
    const files = []
    let file = null, hunk = null, changedLines = 0, truncated = oversized
    const finish = () => {
        if (!file) return
        if ((file.oldPath || file.newPath) && files.length < limits.maxFiles) files.push(file)
        else if (files.length >= limits.maxFiles) truncated = true
        file = null; hunk = null
    }
    const addChange = (kind, line, oldLine, newLine, mappedNewLine) => {
        changedLines++
        if (changedLines > limits.maxChangedLines) { truncated = true; return }
        const change = {
            kind,
            text: String(line).slice(0, limits.maxLineLength),
            ...(oldLine != null ? {oldLine} : {}),
            ...(newLine != null ? {newLine} : {}),
            mappedNewLine,
        }
        ;(kind === 'added' ? file.additions : file.removals).push(change)
    }
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) { finish(); file = emptyFile(headerPaths(line)); continue }
        if (!file && line.startsWith('--- ')) file = emptyFile()
        if (!file) continue
        if (line.startsWith('new file mode ')) { file.newFile = true; continue }
        if (line.startsWith('deleted file mode ')) { file.deletedFile = true; continue }
        if (line.startsWith('rename from ')) { file.oldPath = normalizeChangePath(decodeGitQuoted(line.slice(12))); file.renamed = true; continue }
        if (line.startsWith('rename to ')) { file.newPath = normalizeChangePath(decodeGitQuoted(line.slice(10))); file.renamed = true; continue }
        if (line.startsWith('Binary files ') || line === 'GIT binary patch') { file.binary = true; continue }
        if (!hunk && line.startsWith('--- ')) { file.oldPath = diffPath(line.slice(4), 'a'); if (!file.oldPath) file.newFile = true; continue }
        if (!hunk && line.startsWith('+++ ')) { file.newPath = diffPath(line.slice(4), 'b'); if (!file.newPath) file.deletedFile = true; continue }
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (match) {
            hunk = {
                oldStart: Number(match[1]), oldCount: match[2] == null ? 1 : Number(match[2]),
                newStart: Number(match[3]), newCount: match[4] == null ? 1 : Number(match[4]),
                oldCursor: Number(match[1]), newCursor: Number(match[3]),
            }
            file.hunks.push({oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount})
            continue
        }
        if (!hunk || line.startsWith('\\ No newline')) continue
        if (line.startsWith('+')) { addChange('added', line.slice(1), null, hunk.newCursor, hunk.newCursor); hunk.newCursor++ }
        else if (line.startsWith('-')) { addChange('removed', line.slice(1), hunk.oldCursor, null, hunk.newCursor); hunk.oldCursor++ }
        else { hunk.oldCursor++; hunk.newCursor++ }
    }
    finish()
    return {files, byteLength, changedLines: Math.min(changedLines, limits.maxChangedLines), truncated, oversized, limits}
}
