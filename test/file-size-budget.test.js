import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import {extname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CODE_ROOTS = ['src', 'bin', 'scripts', 'test', 'site']
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

test('maintained code and site assets stay within the 300-line owner-module budget', () => {
    const oversized = []
    for (const file of CODE_ROOTS.flatMap(codeFiles).sort()) {
        const text = readFileSync(join(REPO_ROOT, file), 'utf8')
        const lines = physicalLineCount(text)
        if (lines > MAX_LINES) oversized.push(`${file}: ${lines}`)
    }
    assert.deepEqual(oversized, [], `Split oversized concerns into meaningful owner modules:\n${oversized.join('\n')}`)
    const index = readFileSync(join(REPO_ROOT, 'site/index.html'), 'utf8')
    assert.ok(index.includes('href="/styles.css?v=0.3.3-hosted-shell-1"'), 'the page loads the Hosted-aligned shell stylesheet without a stale asset')
    assert.ok(index.includes('src="/graph-animation.js?v=0.3.3-hero-graph-3"'), 'the page loads the deterministic hero graph without a stale asset')
    const animation = readFileSync(join(REPO_ROOT, 'site/graph-animation.js'), 'utf8')
    assert.doesNotThrow(() => new Function(animation), 'the extracted browser script parses')
    assert.doesNotMatch(animation, /Math\.random/, 'the hero graph layout stays deterministic')
})
