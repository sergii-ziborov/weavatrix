import {createRequire} from 'node:module'
import {existsSync, realpathSync, statSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {graphOutDirForRepo} from '../../graph/layout.js'

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MCP_DIR = join(SOURCE_DIR, 'mcp')
const CATALOG_URL = new URL('../catalog.mjs', import.meta.url)

export const PACKAGE_JSON_PATH = join(SOURCE_DIR, '..', 'package.json')
export const PACKAGE_VERSION = (() => {
    try { return createRequire(import.meta.url)('../../../package.json').version } catch { return '0.0.0' }
})()
export const SERVER_INFO = {name: 'weavatrix', version: PACKAGE_VERSION}

export const loadServerCatalog = (version = 0) => import(version ? `${CATALOG_URL.href}?v=${version}` : CATALOG_URL.href)

export function hotCatalogVersion(hotFiles) {
    let version = 0
    for (const file of hotFiles) {
        try {
            const modified = statSync(join(MCP_DIR, file)).mtimeMs
            if (modified > version) version = modified
        } catch { /* a missing file does not bump the version */ }
    }
    return version
}

export function resolveServerTarget(argv, log = () => {}) {
    let graphPath = argv[2], repoArg = argv[3], capabilities = argv[4]
    try {
        if (graphPath && statSync(graphPath).isDirectory()) {
            repoArg = realpathSync.native(graphPath)
            capabilities = argv[3]
            graphPath = join(graphOutDirForRepo(repoArg), 'graph.json')
            if (!existsSync(graphPath)) log(`no graph built yet for ${repoArg} — ask the agent to call rebuild_graph; it builds into the standard weavatrix-graphs layout`)
        }
    } catch { /* argv[2] is a graph path or unavailable */ }
    let repoRoot = null
    try { if (repoArg && statSync(repoArg).isDirectory()) repoRoot = realpathSync.native(repoArg) } catch { /* invalid repo root */ }
    return {graphPath, repoRoot, capabilities}
}
