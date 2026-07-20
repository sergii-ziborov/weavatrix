import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runCommandSync } from './process.js'

const rgInInstall = (base) => [
    join(base, 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    join(base, 'resources', 'app', 'node_modules', '@vscode', 'ripgrep-universal', 'bin', 'win32-x64', 'rg.exe'),
]

function editorRgCandidates() {
    if (process.platform !== 'win32') return []
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env.PROGRAMFILES || ''
    const roots = [local && join(local, 'Programs', 'Microsoft VS Code'), local && join(local, 'Programs', 'cursor'), pf && join(pf, 'Microsoft VS Code')].filter(Boolean)
    const out = []
    for (const root of roots) {
        if (!existsSync(root)) continue
        out.push(...rgInInstall(root))
        try {
            for (const d of readdirSync(root, {withFileTypes: true})) if (d.isDirectory()) out.push(...rgInInstall(join(root, d.name)))
        } catch { /* optional editor install probe */ }
    }
    return out
}

export function createRgResolver(selfDir) {
    let rgPath
    return function resolveRg() {
        if (rgPath !== undefined) return rgPath
        rgPath = null
        const env = (process.env.WEAVATRIX_RG_CMD || '').replace(/^"|"$/g, '')
        if (env && existsSync(env)) return (rgPath = env)
        try {
            const {rgPath: bundledRg} = createRequire(import.meta.url)('@vscode/ripgrep')
            if (bundledRg && existsSync(bundledRg)) return (rgPath = bundledRg)
        } catch { /* optional bundled ripgrep module */ }
        try {
            const unpackedRg = join(selfDir, '..', '..', 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
            if (existsSync(unpackedRg)) return (rgPath = unpackedRg)
        } catch { /* optional packaged ripgrep path */ }
        for (const c of editorRgCandidates()) if (existsSync(c)) return (rgPath = c)
        try {
            const probe = runCommandSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], {timeout: 3000})
            const p = probe.status === 0 ? probe.stdout.split(/\r?\n/)[0].trim() : ''
            if (p && existsSync(p)) return (rgPath = p)
        } catch { /* optional PATH probe */ }
        return rgPath
    }
}
