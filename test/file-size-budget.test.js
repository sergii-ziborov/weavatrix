import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import {extname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CODE_ROOTS = ['src', 'bin', 'scripts', 'test']
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.css'])
const MAX_LINES = 300

function physicalLineCount(text) {
    if (text === '') return 0
    const lines = text.split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    return lines.length
}

function codeFiles(root) {
    const files = []
    const visit = (absolute, relative = '') => {
        for (const entry of readdirSync(absolute, {withFileTypes: true})) {
            const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
            const nextAbsolute = join(absolute, entry.name)
            if (entry.isDirectory()) visit(nextAbsolute, nextRelative)
            else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(nextRelative)
        }
    }
    visit(join(REPO_ROOT, root))
    return files.map((file) => `${root}/${file}`)
}

// The weavatrix.com site (and its asset checks) moved to the separate weavatrix-site repository.
test('maintained code stays within the 300-line owner-module budget', () => {
    const oversized = []
    for (const file of CODE_ROOTS.flatMap(codeFiles).sort()) {
        const text = readFileSync(join(REPO_ROOT, file), 'utf8')
        const lines = physicalLineCount(text)
        if (lines > MAX_LINES) oversized.push(`${file}: ${lines}`)
    }
    assert.deepEqual(oversized, [], `Split oversized concerns into meaningful owner modules:\n${oversized.join('\n')}`)
})
