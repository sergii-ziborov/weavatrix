import {createRequire} from 'node:module'

const requireFromWeavatrix = createRequire(import.meta.url)

export const WEAVATRIX_VERSION = String(
    requireFromWeavatrix('../package.json').version || 'unknown',
)
