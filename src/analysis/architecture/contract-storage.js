import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {createRepoBoundary} from '../../repo-path.js'
import {normalizeArchitectureContract} from './contract-schema.js'

export const CONTRACT_PATHS = ['.weavatrix/architecture.json', '.weavatrix-architecture.json']

const readContract = (path, source) => {
    try {
        return {contract: normalizeArchitectureContract(JSON.parse(readFileSync(path, 'utf8'))), source}
    } catch (error) {
        return {contract: null, source, error: error.message}
    }
}

export function loadArchitectureContract(repoRoot, graphPath) {
    const boundary = createRepoBoundary(repoRoot)
    for (const relative of CONTRACT_PATHS) {
        const resolved = boundary.resolve(relative)
        if (resolved.ok && existsSync(resolved.path)) return readContract(resolved.path, relative)
    }
    const cached = graphPath ? join(dirname(graphPath), 'architecture.contract.json') : null
    return cached && existsSync(cached)
        ? readContract(cached, 'extension-cache')
        : {contract: null, source: null, error: null}
}

export function writeCachedArchitectureContract(graphPath, input) {
    if (!graphPath) throw new Error('graph path is required for extension contract cache')
    const contract = normalizeArchitectureContract(input)
    const path = join(dirname(graphPath), 'architecture.contract.json')
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, JSON.stringify(contract, null, 2), 'utf8')
    return {path, contract}
}
