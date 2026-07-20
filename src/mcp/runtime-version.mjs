import {readFileSync} from 'node:fs'
import process from 'node:process'

const STALE_RUNTIME_OVERRIDE_ENV = 'WEAVATRIX_ALLOW_STALE_RUNTIME'

export function runtimeVersionStatus({runningVersion, packageJsonPath, allowStale} = {}) {
    let diskVersion = null, packageVersionError = null
    try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
        diskVersion = typeof parsed?.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null
        if (!diskVersion) packageVersionError = 'package.json has no valid version'
    } catch (error) {
        packageVersionError = `package.json is unreadable: ${error.message}`
    }
    const staleRuntime = diskVersion !== String(runningVersion || '')
    const staleRuntimeAllowed = allowStale == null
        ? process.env[STALE_RUNTIME_OVERRIDE_ENV] === '1'
        : allowStale === true
    return {
        version: String(runningVersion || ''),
        diskVersion,
        staleRuntime,
        staleRuntimeAllowed,
        ...(packageVersionError ? {packageVersionError} : {}),
    }
}

export function staleRuntimeMessage(status) {
    const disk = status.diskVersion || 'unavailable'
    return `STALE_RUNTIME: running Weavatrix ${status.version || 'unknown'} but package.json on disk is ${disk}. Restart/reconnect the MCP server before using tools. For deliberate source-development only, set ${STALE_RUNTIME_OVERRIDE_ENV}=1.`
}
