import {delimiter, dirname, join} from 'node:path'
import {childProcessEnv} from '../../child-env.js'

const LSP_ENV_ALLOWLIST = new Set([
    'path', 'pathext', 'systemroot', 'windir', 'comspec',
    'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'localappdata', 'appdata',
    'lang', 'language', 'lc_all', 'lc_ctype',
])

export function lspChildProcessEnv(overrides = {}) {
    const inherited = childProcessEnv(overrides)
    const clean = Object.fromEntries(
        Object.entries(inherited).filter(([key]) => LSP_ENV_ALLOWLIST.has(key.toLowerCase())),
    )
    const safePath = [dirname(process.execPath)]
    const systemRoot = inherited.SystemRoot || inherited.SYSTEMROOT || inherited.WINDIR
    if (process.platform === 'win32' && systemRoot) safePath.push(join(systemRoot, 'System32'))
    clean.PATH = [...new Set(safePath)].join(delimiter)
    return clean
}
