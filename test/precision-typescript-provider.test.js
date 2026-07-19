import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {
    activeLspClientCount,
    ContentLengthMessageParser,
    createRepoUriNormalizer,
    lspChildProcessEnv,
    LspProtocolError,
    shutdownActiveLspClients,
    startStdioLspClient,
} from '../src/precision/lsp-client.js'
import {
    classifyTypeScriptReferenceUsage,
    createTypeScriptLspClient,
    typeScriptLspAvailability,
    typeScriptLanguageId,
    typeScriptProjectSafety,
} from '../src/precision/typescript-lsp-provider.js'

test('TypeScript provider discovery is explicit and language ids are deterministic', () => {
    const availability = typeScriptLspAvailability()
    assert.equal(availability.provider, 'typescript-language-server')
    assert.equal(typeof availability.available, 'boolean')
    assert.equal(typeScriptLanguageId('src/a.ts'), 'typescript')
    assert.equal(typeScriptLanguageId('src/a.tsx'), 'typescriptreact')
    assert.equal(typeScriptLanguageId('src/a.mjs'), 'javascript')
    assert.equal(typeScriptLanguageId('src/a.jsx'), 'javascriptreact')
    assert.equal(typeScriptLanguageId('src/a.py'), null)
})

test('TypeScript reference usage distinguishes type queries from runtime values', () => {
    const source = [
        'function helper() {}',
        'type Helper = typeof helper;',
        'const called = helper();',
        'const inspected = typeof helper;',
        'class Child extends Base implements Contract {}',
    ].join('\n')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 1, character: 21}), 'type')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 2, character: 15}), 'value')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 3, character: 25}), 'value')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 4, character: 20}), 'value')
    assert.equal(classifyTypeScriptReferenceUsage('src/usage.ts', source, {line: 4, character: 36}), 'type')
})

test('TypeScript project safety rejects plugins in direct, extended, and referenced configs', async (t) => {
    const makeFixture = () => {
        const root = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-safety-'))
        mkdirSync(join(root, 'src'), {recursive: true})
        writeFileSync(join(root, 'src', 'main.ts'), 'export const main = 1\n')
        return root
    }
    await t.test('direct config', () => {
        const root = makeFixture()
        try {
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
                compilerOptions: {plugins: [{name: 'evil-plugin'}]},
                files: ['src/main.ts'],
            }))
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIGURED_TSSERVER_PLUGINS')
        } finally { rmSync(root, {recursive: true, force: true}) }
    })
    await t.test('extends chain', () => {
        const root = makeFixture()
        try {
            writeFileSync(join(root, 'base.json'), JSON.stringify({
                compilerOptions: {plugins: [{name: 'evil-plugin'}]},
            }))
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
                extends: './base.json',
                files: ['src/main.ts'],
            }))
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIGURED_TSSERVER_PLUGINS')
        } finally { rmSync(root, {recursive: true, force: true}) }
    })
    await t.test('project reference', () => {
        const root = makeFixture()
        try {
            mkdirSync(join(root, 'packages', 'child'), {recursive: true})
            writeFileSync(join(root, 'packages', 'child', 'child.ts'), 'export const child = 1\n')
            writeFileSync(join(root, 'packages', 'child', 'tsconfig.json'), JSON.stringify({
                compilerOptions: {composite: true, plugins: [{name: 'evil-plugin'}]},
                files: ['child.ts'],
            }))
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
                files: ['src/main.ts'],
                references: [{path: './packages/child'}],
            }))
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIGURED_TSSERVER_PLUGINS')
        } finally { rmSync(root, {recursive: true, force: true}) }
    })
})

test('TypeScript project safety refuses unresolved and outside extends configs', async (t) => {
    const run = (extendsPath) => {
        const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-boundary-'))
        const root = join(parent, 'repo')
        mkdirSync(join(root, 'src'), {recursive: true})
        writeFileSync(join(root, 'src', 'main.ts'), 'export const main = 1\n')
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({extends: extendsPath, files: ['src/main.ts']}))
        try { return typeScriptProjectSafety(root, ['src/main.ts']) }
        finally { rmSync(parent, {recursive: true, force: true}) }
    }
    await t.test('unresolved', () => {
        const safety = run('./missing.json')
        assert.equal(safety.safe, false)
        assert.match(safety.reason, /CONFIG/)
    })
    await t.test('outside repository', () => {
        const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-outside-'))
        const root = join(parent, 'repo')
        mkdirSync(join(root, 'src'), {recursive: true})
        writeFileSync(join(parent, 'base.json'), JSON.stringify({compilerOptions: {strict: true}}))
        writeFileSync(join(root, 'src', 'main.ts'), 'export const main = 1\n')
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({extends: '../base.json', files: ['src/main.ts']}))
        try {
            const safety = typeScriptProjectSafety(root, ['src/main.ts'])
            assert.equal(safety.safe, false)
            assert.equal(safety.reason, 'CONFIG_OUTSIDE_REPOSITORY')
        } finally { rmSync(parent, {recursive: true, force: true}) }
    })
})

test('TypeScript project discovery stops at the synchronous entry and deadline budgets', () => {
    const root = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-config-budget-'))
    mkdirSync(join(root, 'src'), {recursive: true})
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({include: ['src/**/*.ts']}))
    for (let index = 0; index < 8; index++) {
        writeFileSync(join(root, 'src', `file-${index}.ts`), `export const value${index} = ${index}\n`)
    }
    try {
        const entryLimited = typeScriptProjectSafety(root, ['src/file-0.ts'], {maxDirectoryEntries: 4})
        assert.equal(entryLimited.safe, false)
        assert.equal(entryLimited.reason, 'PROJECT_INPUT_LIMIT')

        const deadlineLimited = typeScriptProjectSafety(root, ['src/file-0.ts'], {deadline: Date.now() - 1})
        assert.equal(deadlineLimited.safe, false)
        assert.equal(deadlineLimited.reason, 'SAFETY_DEADLINE')
    } finally { rmSync(root, {recursive: true, force: true}) }
})

test('bundled TypeScript language server returns semantic definitions and references', {timeout: 30_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-lsp-'))
    const repo = join(parent, 'repo')
    const libraryText = 'export function greet(name: string) {\n  return `hello ${name}`\n}\n'
    const applicationText = "import {greet} from './lib.js'\nexport const message = greet('world')\n"
    mkdirSync(join(repo, 'src'), {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'typescript-lsp-fixture', private: true, type: 'module'}))
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({compilerOptions: {module: 'NodeNext', moduleResolution: 'NodeNext', strict: true}}))
    writeFileSync(join(repo, 'src', 'lib.ts'), libraryText)
    writeFileSync(join(repo, 'src', 'app.ts'), applicationText)

    let provider
    try {
        provider = await createTypeScriptLspClient({repoRoot: repo, timeoutMs: 10_000})
        assert.equal(provider.provider, 'typescript-language-server')
        await provider.openDocument('src/lib.ts', libraryText)
        await provider.openDocument('src/app.ts', applicationText)
        const definitions = await provider.definition('src/app.ts', {line: 1, character: 24})
        assert.ok(definitions.some((location) => location.file === 'src/lib.ts'), JSON.stringify(definitions))
        const references = await provider.references('src/lib.ts', {line: 0, character: 17}, true)
        assert.ok(references.some((location) => location.file === 'src/lib.ts'), JSON.stringify(references))
        assert.ok(references.some((location) => location.file === 'src/app.ts'), JSON.stringify(references))
    } finally {
        await provider?.close()
        rmSync(parent, {recursive: true, force: true})
    }
})

test('bundled TypeScript provider never loads a repository-local tsserver plugin', {timeout: 30_000}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'weavatrix-typescript-plugin-'))
    const repo = join(parent, 'repo')
    const pluginDir = join(repo, 'node_modules', 'evil-plugin')
    const sentinel = join(parent, 'plugin-loaded.txt')
    const sourceText = 'export function answer() { return 42 }\nexport const value = answer()\n'
    mkdirSync(join(repo, 'src'), {recursive: true})
    mkdirSync(pluginDir, {recursive: true})
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'typescript-plugin-fixture', private: true}))
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {plugins: [{name: 'evil-plugin'}]},
        include: ['src/**/*.ts'],
    }))
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({name: 'evil-plugin', version: '1.0.0', main: 'index.js'}))
    writeFileSync(join(pluginDir, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'loaded')\nmodule.exports = () => ({create: info => info.languageService})\n`)
    writeFileSync(join(repo, 'src', 'main.ts'), sourceText)

    let provider
    try {
        provider = await createTypeScriptLspClient({repoRoot: repo, timeoutMs: 10_000})
        await provider.openDocument('src/main.ts', sourceText)
        const references = await provider.references('src/main.ts', {line: 0, character: 16}, true)
        assert.ok(references.some((location) => location.file === 'src/main.ts'), JSON.stringify(references))
        assert.equal(existsSync(sentinel), false, 'repo-local TypeScript plugins must never execute')
    } finally {
        await provider?.close()
        rmSync(parent, {recursive: true, force: true})
    }
})

