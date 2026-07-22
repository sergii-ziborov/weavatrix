import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildOrganizeImportsPlan} from '../src/analysis/organize-imports-plan.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-organize-'))
    for (const [path, content] of Object.entries(files)) writeFileSync(join(repoRoot, path), content)
    return repoRoot
}

const applyFile = (repoRoot, planFile) => {
    const content = readFileSync(join(repoRoot, planFile.path), 'utf8')
    const offset = (line, char) => {
        let start = 0
        for (let current = 1; current < line; current += 1) start = content.indexOf('\n', start) + 1
        return start + char
    }
    const edits = [...planFile.edits].sort((a, b) => offset(b.startLine, b.startChar) - offset(a.startLine, a.startChar))
    let next = content
    for (const edit of edits) {
        const start = offset(edit.startLine, edit.startChar)
        const end = offset(edit.endLine, edit.endChar)
        assert.equal(next.slice(start, end), edit.before)
        next = next.slice(0, start) + edit.after + next.slice(end)
    }
    return next
}

test('removes one unused named specifier and keeps the used sibling, byte-exact', async () => {
    const repoRoot = fixtureRepo({'a.ts': "import {used, dead} from './x'\nexport const y = used()\n"})
    const result = await buildOrganizeImportsPlan({repoRoot, file: 'a.ts'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(applyFile(repoRoot, result.plan.files[0]), "import {used} from './x'\nexport const y = used()\n")
})

test('removes a whole import statement when every named binding is unused', async () => {
    const repoRoot = fixtureRepo({'a.ts': "import {a, b} from './x'\nimport {keep} from './y'\nexport const z = keep\n"})
    const result = await buildOrganizeImportsPlan({repoRoot, file: 'a.ts'})
    assert.equal(applyFile(repoRoot, result.plan.files[0]), "import {keep} from './y'\nexport const z = keep\n")
})

test('a name used only in a TYPE position is not removed', async () => {
    const repoRoot = fixtureRepo({'a.ts': "import {User, Dead} from './types'\nexport const f = (u: User) => u\n"})
    const result = await buildOrganizeImportsPlan({repoRoot, file: 'a.ts'})
    // User kept (type usage counted), Dead removed
    assert.equal(applyFile(repoRoot, result.plan.files[0]), "import {User} from './types'\nexport const f = (u: User) => u\n")
})

test('an unused default/namespace import is UNCERTAIN, never removed (JSX-factory safety)', async () => {
    const repoRoot = fixtureRepo({'a.tsx': "import React from 'react'\nimport {dead} from './x'\nexport const v = 1\n"})
    const result = await buildOrganizeImportsPlan({repoRoot, file: 'a.tsx'})
    // React (default) is NOT removed — reported uncertain; the unused named {dead} IS removed
    assert.ok(result.plan.uncertainReferences.some((ref) => ref.name === 'React' && ref.kind === 'default'))
    assert.equal(applyFile(repoRoot, result.plan.files[0]).includes("import React from 'react'"), true)
    assert.equal(applyFile(repoRoot, result.plan.files[0]).includes('dead'), false)
})

test('a side-effect import is never touched', async () => {
    const repoRoot = fixtureRepo({'a.ts': "import './polyfill'\nimport {keep} from './y'\nexport const z = keep\n"})
    const result = await buildOrganizeImportsPlan({repoRoot, file: 'a.ts'})
    assert.equal(result.status, 'NO_UNUSED_IMPORTS')
})

test('an aliased unused import is removed by its local name', async () => {
    const repoRoot = fixtureRepo({'a.ts': "import {foo as bar, keep} from './x'\nexport const z = keep\n"})
    const result = await buildOrganizeImportsPlan({repoRoot, file: 'a.ts'})
    assert.equal(applyFile(repoRoot, result.plan.files[0]), "import {keep} from './x'\nexport const z = keep\n")
})

test('a file with no unused imports reports NO_UNUSED_IMPORTS', async () => {
    const repoRoot = fixtureRepo({'a.ts': "import {a} from './x'\nexport const y = a()\n"})
    assert.equal((await buildOrganizeImportsPlan({repoRoot, file: 'a.ts'})).status, 'NO_UNUSED_IMPORTS')
})

test('non-JS/TS and unreadable files fail closed', async () => {
    const repoRoot = fixtureRepo({'a.py': 'import os\n'})
    assert.equal((await buildOrganizeImportsPlan({repoRoot, file: 'a.py'})).status, 'NOT_SUPPORTED')
    assert.equal((await buildOrganizeImportsPlan({repoRoot, file: 'gone.ts'})).status, 'SOURCE_UNAVAILABLE')
})

test('always warns that sorting is not applied', async () => {
    const repoRoot = fixtureRepo({'a.ts': "import {used, dead} from './x'\nexport const y = used\n"})
    const result = await buildOrganizeImportsPlan({repoRoot, file: 'a.ts'})
    assert.ok(result.plan.warnings.includes('SORTING_NOT_APPLIED'))
})
