import {test} from 'node:test'
import assert from 'node:assert/strict'
import {isRelativeSpecifier, posixRelative, rewriteRelativeSpecifier} from '../src/analysis/import-specifier.js'

test('isRelativeSpecifier distinguishes relative from bare/alias', () => {
    for (const spec of ['.', '..', './x', '../y/z']) assert.equal(isRelativeSpecifier(spec), true, spec)
    for (const spec of ['react', '@scope/pkg', 'lodash/fp', '@/alias']) assert.equal(isRelativeSpecifier(spec), false, spec)
})

test('posixRelative computes forward-slash relative paths and never leaks separators', () => {
    assert.equal(posixRelative('src/a', 'src/b/util.ts'), '../b/util.ts')
    assert.equal(posixRelative('src', 'src/b/util.ts'), './b/util.ts')
    assert.equal(posixRelative('src/a', 'src/util.ts'), '../util.ts')
    assert.equal(posixRelative('src/a/b', 'lib/x.ts'), '../../../lib/x.ts')
    assert.equal(posixRelative('', 'util.ts'), './util.ts')
})

test('rewrites an extensionless specifier preserving the extensionless style', () => {
    // b.ts imports ./util (=> old/util.ts); the file moved to new/util.ts and b.ts stayed put
    const result = rewriteRelativeSpecifier({specifier: './util', targetFile: 'new/util.ts', newImporterDir: 'old'})
    assert.equal(result.specifier, '../new/util')
})

test('rewrites a specifier that carried an extension keeping the extension', () => {
    const result = rewriteRelativeSpecifier({specifier: './util.ts', targetFile: 'new/util.ts', newImporterDir: 'old'})
    assert.equal(result.specifier, '../new/util.ts')
})

test('rewrites a directory-index import to the new directory', () => {
    // ./widgets => widgets/index.ts
    const result = rewriteRelativeSpecifier({specifier: './widgets', targetFile: 'ui/widgets/index.ts', newImporterDir: 'app'})
    assert.equal(result.specifier, '../ui/widgets')
})

test('an explicit /index specifier is treated as a normal extensionless path', () => {
    const result = rewriteRelativeSpecifier({specifier: './widgets/index', targetFile: 'ui/widgets/index.ts', newImporterDir: 'app'})
    assert.equal(result.specifier, '../ui/widgets/index')
})

test('a mismatched explicit extension (.js for a .ts file) is left UNCERTAIN, never guessed', () => {
    const result = rewriteRelativeSpecifier({specifier: './util.js', targetFile: 'new/util.ts', newImporterDir: 'old'})
    assert.equal(result.uncertain, true)
    assert.equal(result.reason, 'EXTENSION_MAPPING')
})

test('non-relative and non-JS targets are UNCERTAIN', () => {
    assert.equal(rewriteRelativeSpecifier({specifier: '@app/util', targetFile: 'new/util.ts', newImporterDir: 'old'}).reason, 'NON_RELATIVE_SPECIFIER')
    assert.equal(rewriteRelativeSpecifier({specifier: './data', targetFile: 'new/data.json', newImporterDir: 'old'}).reason, 'NON_JS_TARGET')
})

test('same-directory move keeps a bare-name relative specifier', () => {
    // importer and target both end up in src/; ./util stays ./util
    const result = rewriteRelativeSpecifier({specifier: './util', targetFile: 'src/util.ts', newImporterDir: 'src'})
    assert.equal(result.specifier, './util')
})
