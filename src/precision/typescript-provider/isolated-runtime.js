import {copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join} from 'node:path'

const RUNTIME_FILES = new Set([
    'tsserver.js', '_tsserver.js', 'typescript.js',
    'typingsInstaller.js', '_typingsInstaller.js', 'typesMap.json', 'watchGuard.js',
])

function materialize(source, target) {
    try { linkSync(source, target) }
    catch { copyFileSync(source, target) }
}

export function isolateTypeScriptRuntime(tsserverPath) {
    const sourceLib = dirname(tsserverPath)
    const sourceRoot = dirname(sourceLib)
    const root = mkdtempSync(join(tmpdir(), 'weavatrix-tsserver-'))
    const lib = join(root, 'lib')
    mkdirSync(lib, {recursive: true, mode: 0o700})
    try {
        materialize(join(sourceRoot, 'package.json'), join(root, 'package.json'))
        const files = readdirSync(sourceLib).filter((name) =>
            RUNTIME_FILES.has(name) || /^lib(?:\..+)?\.d\.ts$/i.test(name))
        for (const name of files) materialize(join(sourceLib, name), join(lib, basename(name)))
        let cleaned = false
        return {
            tsserverPath: join(lib, 'tsserver.js'),
            cleanup() {
                if (cleaned) return
                cleaned = true
                try { rmSync(root, {recursive: true, force: true}) } catch { /* process cleanup fallback */ }
            },
        }
    } catch (error) {
        try { rmSync(root, {recursive: true, force: true}) } catch { /* best effort */ }
        throw error
    }
}
