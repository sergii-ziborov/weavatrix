import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildMoveFilePlan, simulateFileMove} from '../src/analysis/move-file-plan.js'
import {normalizeArchitectureContract} from '../src/analysis/architecture-contract.js'

const fixtureRepo = (files) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wvx-move-'))
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repoRoot, path, '..'), {recursive: true})
        writeFileSync(join(repoRoot, path), content)
    }
    return repoRoot
}

const fileNode = (path) => ({id: path, source_file: path, label: path})
const importLink = (source, target, specifier, line) => ({source, target, relation: 'imports', confidence: 'EXTRACTED', line, specifier})

test('simulateFileMove relabels the file node, its symbols, and every touching edge', () => {
    const graph = {
        nodes: [fileNode('old/a.ts'), {id: 'old/a.ts#run@1', source_file: 'old/a.ts', label: 'run'}, fileNode('b.ts')],
        links: [importLink('b.ts', 'old/a.ts', './old/a', 1), {source: 'b.ts#main@1', target: 'old/a.ts#run@1', relation: 'calls'}],
    }
    const moved = simulateFileMove(graph, 'old/a.ts', 'new/a.ts')
    assert.ok(moved.nodes.some((node) => node.id === 'new/a.ts' && node.source_file === 'new/a.ts'))
    assert.ok(moved.nodes.some((node) => node.id === 'new/a.ts#run@1' && node.source_file === 'new/a.ts'))
    assert.ok(moved.links.some((link) => link.target === 'new/a.ts'))
    assert.ok(moved.links.some((link) => link.target === 'new/a.ts#run@1'))
    // input graph is untouched
    assert.ok(graph.nodes.some((node) => node.id === 'old/a.ts'))
})

test('rewrites an importer specifier and the moved file own imports, byte-exact', () => {
    const repoRoot = fixtureRepo({
        'src/app.ts': "import {help} from './lib/helper'\n",
        'src/lib/helper.ts': "import {sib} from './sibling'\nexport const help = () => sib\n",
        'src/lib/sibling.ts': 'export const sib = 1\n',
    })
    const rawGraph = {
        nodes: [fileNode('src/app.ts'), fileNode('src/lib/helper.ts'), fileNode('src/lib/sibling.ts')],
        links: [
            importLink('src/app.ts', 'src/lib/helper.ts', './lib/helper', 1),
            importLink('src/lib/helper.ts', 'src/lib/sibling.ts', './sibling', 1),
        ],
    }
    const result = buildMoveFilePlan({repoRoot, rawGraph, fromPath: 'src/lib/helper.ts', toPath: 'src/domain/helper.ts'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.completeness, 'COMPLETE')
    assert.equal(result.rename.to, 'src/domain/helper.ts')
    const appEdit = result.edits.find((edit) => edit.file === 'src/app.ts')
    assert.equal(appEdit.before, './lib/helper')
    assert.equal(appEdit.after, './domain/helper')
    assert.equal(appEdit.role, 'importer')
    // byte-exact: the located range must equal the specifier text inside the quotes
    const line = "import {help} from './lib/helper'\n"
    assert.equal(line.slice(appEdit.startChar, appEdit.endChar), './lib/helper')
    const selfEdit = result.edits.find((edit) => edit.file === 'src/lib/helper.ts')
    assert.equal(selfEdit.before, './sibling')
    assert.equal(selfEdit.after, '../lib/sibling')
    assert.equal(selfEdit.role, 'moved-file-self')
})

test('a specifier that does not change is skipped, not emitted as a no-op edit', () => {
    const repoRoot = fixtureRepo({
        'src/lib/helper.ts': "import {b} from '../ui/button'\nexport const help = b\n",
        'src/ui/button.ts': 'export const b = 1\n',
    })
    const rawGraph = {
        nodes: [fileNode('src/lib/helper.ts'), fileNode('src/ui/button.ts')],
        links: [importLink('src/lib/helper.ts', 'src/ui/button.ts', '../ui/button', 1)],
    }
    // src/lib -> src/domain: both are one level under src, so ../ui/button is unchanged
    const result = buildMoveFilePlan({repoRoot, rawGraph, fromPath: 'src/lib/helper.ts', toPath: 'src/domain/helper.ts'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.edits.length, 0)
})

test('a non-relative importer is reported UNCERTAIN, never rewritten', () => {
    const repoRoot = fixtureRepo({'src/app.ts': "import {h} from '@app/helper'\n", 'src/helper.ts': 'export const h = 1\n'})
    const rawGraph = {
        nodes: [fileNode('src/app.ts'), fileNode('src/helper.ts')],
        links: [importLink('src/app.ts', 'src/helper.ts', '@app/helper', 1)],
    }
    const result = buildMoveFilePlan({repoRoot, rawGraph, fromPath: 'src/helper.ts', toPath: 'src/lib/helper.ts'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.completeness, 'PARTIAL')
    assert.equal(result.uncertain[0].reason, 'NON_RELATIVE_IMPORTER')
    assert.ok(result.warnings.includes('UNCERTAIN_SPECIFIERS_PRESENT'))
})

test('a specifier the arithmetic maps but cannot locate on its line is UNCERTAIN', () => {
    const repoRoot = fixtureRepo({'src/app.ts': '// the import line was edited away\n', 'src/helper.ts': 'export const h = 1\n'})
    const rawGraph = {
        nodes: [fileNode('src/app.ts'), fileNode('src/helper.ts')],
        links: [importLink('src/app.ts', 'src/helper.ts', './helper', 1)],
    }
    const result = buildMoveFilePlan({repoRoot, rawGraph, fromPath: 'src/helper.ts', toPath: 'lib/helper.ts'})
    assert.equal(result.status, 'PLANNED')
    assert.equal(result.uncertain[0].reason, 'SPECIFIER_NOT_LOCATED')
})

test('without a contract the architecture verdict is NOT_CONFIGURED', () => {
    const repoRoot = fixtureRepo({'a.ts': 'export const x = 1\n'})
    const rawGraph = {nodes: [fileNode('a.ts')], links: []}
    const result = buildMoveFilePlan({repoRoot, rawGraph, fromPath: 'a.ts', toPath: 'b.ts'})
    assert.equal(result.architecture.status, 'NOT_CONFIGURED')
})

test('the architecture dry-run predicts a violation the new location would introduce', () => {
    const repoRoot = fixtureRepo({
        'src/lib/helper.ts': "import {b} from '../ui/button'\nexport const help = b\n",
        'src/ui/button.ts': 'export const b = 1\n',
    })
    const rawGraph = {
        nodes: [fileNode('src/lib/helper.ts'), fileNode('src/ui/button.ts')],
        links: [importLink('src/lib/helper.ts', 'src/ui/button.ts', '../ui/button', 1)],
    }
    const contract = normalizeArchitectureContract({
        name: 'Layered', style: 'clean', enforcement: 'ratchet',
        components: [{id: 'ui', paths: ['src/ui']}, {id: 'domain', paths: ['src/domain']}],
        dependencyRules: [{id: 'domain-no-ui', action: 'forbid', from: ['domain'], to: ['ui'], kinds: ['runtime']}],
        budgets: {runtimeCycles: 0},
    })
    // moving helper into src/domain makes domain import ui -> forbidden
    const result = buildMoveFilePlan({repoRoot, rawGraph, fromPath: 'src/lib/helper.ts', toPath: 'src/domain/helper.ts', contract})
    assert.equal(result.architecture.status, 'WOULD_VIOLATE')
    assert.equal(result.architecture.wouldIntroduce.length, 1)
    assert.ok(result.warnings.includes('WOULD_INTRODUCE_ARCHITECTURE_VIOLATION'))
})

test('expected failure modes are explicit statuses', () => {
    const repoRoot = fixtureRepo({'a.ts': 'export const x = 1\n'})
    const rawGraph = {nodes: [fileNode('a.ts'), fileNode('taken.ts')], links: []}
    const call = (over) => buildMoveFilePlan({repoRoot, rawGraph, fromPath: 'a.ts', toPath: 'b.ts', ...over})
    assert.equal(call({toPath: 'a.ts'}).status, 'NO_CHANGE')
    assert.equal(call({fromPath: 'a.py', toPath: 'b.py'}).status, 'NOT_SUPPORTED')
    assert.equal(call({fromPath: 'missing.ts'}).status, 'NOT_FOUND')
    assert.equal(call({toPath: 'taken.ts'}).status, 'TARGET_EXISTS')
})
