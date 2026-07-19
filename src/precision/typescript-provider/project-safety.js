import {createHash} from 'node:crypto'
import {readFileSync, statSync} from 'node:fs'
import {relative} from 'node:path'
import {
    canonicalKey,
    guardedExistingPath,
    nearestTypeScriptConfig,
    norm,
    parseRepoConfig,
    safetyBudget,
    typeScriptRepoContext,
} from './project-host.js'

const MAX_PROJECT_FILES = 8_192
const MAX_CONFIG_FILES = 128
const MAX_EXTRA_INPUT_BYTES = 64 * 1024 * 1024
const MAX_PROJECT_INPUT_BYTES = 128 * 1024 * 1024
const MAX_SINGLE_INPUT_BYTES = 4 * 1024 * 1024

function referenceConfigPath(context, reference) {
    const {root, ts} = context
    let candidate
    try {
        candidate = typeof ts.resolveProjectReferencePath === 'function'
            ? ts.resolveProjectReferencePath(reference)
            : reference?.path
    } catch { return null }
    if (!candidate) return null
    return guardedExistingPath(root, candidate)
}

export function typeScriptProjectSafety(repoRoot, relFiles = [], options = {}) {
    const context = typeScriptRepoContext(repoRoot)
    if (!context) return {safe: false, reason: 'TYPESCRIPT_UNAVAILABLE', fingerprint: null}
    const {root} = context
    const budget = safetyBudget(options)
    const files = [...new Set((relFiles || []).map(norm).filter(Boolean))].sort()
    if (files.length > MAX_PROJECT_FILES) return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
    const graphFiles = new Set(files)
    const mappings = []
    const fileConfigs = {}
    const queue = []
    const queued = new Set()
    for (const file of files) {
        const absolute = guardedExistingPath(root, file)
        if (!absolute) return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
        const nearest = nearestTypeScriptConfig(context, absolute)
        if (!nearest.ok) return {safe: false, reason: nearest.reason, fingerprint: null}
        const configRel = nearest.configPath ? norm(relative(root, nearest.configPath)) : '<inferred>'
        mappings.push(`${file}=>${configRel}`)
        fileConfigs[file] = nearest.configPath ? configRel : null
        if (nearest.configPath && !queued.has(nearest.configPath)) {
            queued.add(nearest.configPath)
            queue.push(nearest.configPath)
        }
    }

    const configRecords = new Map()
    const projectFiles = new Set()
    const configuredPlugins = new Set()
    const projects = {}
    for (let cursor = 0; cursor < queue.length; cursor++) {
        if (Date.now() >= budget.deadline) return {safe: false, reason: 'SAFETY_DEADLINE', fingerprint: null}
        if (queue.length > MAX_CONFIG_FILES) return {safe: false, reason: 'CONFIG_INPUT_LIMIT', fingerprint: null}
        const configPath = queue[cursor]
        const parsed = parseRepoConfig(context, configPath, budget)
        if (!parsed.complete) return {safe: false, reason: parsed.reason, fingerprint: null}
        const configRel = norm(relative(root, configPath))
        projects[configRel] = {
            projectFiles: parsed.projectFiles,
            configFiles: [...parsed.configRecords.keys()].sort(),
            configuredPlugins: parsed.plugins,
        }
        for (const plugin of parsed.plugins || []) configuredPlugins.add(plugin)
        for (const [file, digest] of parsed.configRecords) {
            configRecords.set(file, digest)
            if (configRecords.size > MAX_CONFIG_FILES) {
                return {safe: false, reason: 'CONFIG_INPUT_LIMIT', fingerprint: null}
            }
        }
        for (const file of parsed.projectFiles) {
            projectFiles.add(file)
            if (projectFiles.size > MAX_PROJECT_FILES) {
                return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
            }
        }
        for (const reference of parsed.parsed.projectReferences || []) {
            const referenced = referenceConfigPath(context, reference)
            if (!referenced) return {safe: false, reason: 'PROJECT_REFERENCE_UNRESOLVED', fingerprint: null}
            if (!queued.has(referenced)) {
                queued.add(referenced)
                queue.push(referenced)
            }
        }
    }

    const extraRecords = []
    let projectBytes = 0
    let extraBytes = 0
    for (const file of [...projectFiles].sort()) {
        if (Date.now() >= budget.deadline) return {safe: false, reason: 'SAFETY_DEADLINE', fingerprint: null}
        const absolute = guardedExistingPath(root, file)
        if (!absolute) return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
        let size
        try {
            const stats = statSync(absolute)
            if (!stats.isFile()) return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null}
            size = stats.size
            if (size > MAX_SINGLE_INPUT_BYTES || projectBytes + size > MAX_PROJECT_INPUT_BYTES) {
                return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
            }
        } catch { return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null} }
        projectBytes += size
        if (graphFiles.has(file)) continue
        if (extraBytes + size > MAX_EXTRA_INPUT_BYTES) {
            return {safe: false, reason: 'PROJECT_INPUT_LIMIT', fingerprint: null}
        }
        let body
        try { body = readFileSync(absolute) }
        catch { return {safe: false, reason: 'UNREADABLE_PROJECT_INPUT', fingerprint: null} }
        extraBytes += body.byteLength
        extraRecords.push(`${file}:${createHash('sha256').update(body).digest('hex')}`)
    }
    const fingerprint = createHash('sha256').update([
        ...mappings.map((item) => `map:${item}`),
        ...[...configRecords.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([file, digest]) => `config:${file}:${digest}`),
        ...[...projectFiles].sort().map((file) => `project:${file}`),
        ...extraRecords.map((item) => `extra:${item}`),
    ].join('\n')).digest('hex')
    return {
        safe: true,
        reason: null,
        fingerprint,
        configFiles: [...configRecords.keys()].sort(),
        projectFiles: [...projectFiles].sort(),
        fileConfigs,
        projects,
        configuredPlugins: [...configuredPlugins].sort(),
        pluginsSuppressed: configuredPlugins.size,
    }
}

export function typeScriptConfiguredProjectMembership(repoRoot, relFile) {
    const context = typeScriptRepoContext(repoRoot)
    if (!context) return {complete: false, member: false, reason: 'TYPESCRIPT_UNAVAILABLE'}
    const {root, caseSensitive} = context
    const target = guardedExistingPath(root, relFile)
    if (!target) return {complete: false, member: false, reason: 'UNREADABLE_PATH'}
    const nearest = nearestTypeScriptConfig(context, target)
    if (!nearest.ok) return {complete: false, member: false, reason: nearest.reason}
    const configPath = nearest.configPath
    if (!configPath) return {complete: false, member: false, reason: 'NO_CONFIGURED_PROJECT'}
    const parsed = parseRepoConfig(context, configPath, safetyBudget())
    if (!parsed.complete) return {complete: false, member: false, reason: parsed.reason}
    const targetKey = canonicalKey(target, caseSensitive)
    const member = parsed.projectKeys.has(targetKey)
    return {
        complete: true,
        member,
        projectFiles: parsed.projectFiles,
        configFiles: [...parsed.configRecords.keys()].sort(),
        configFile: norm(relative(root, configPath)),
        reason: member ? null : 'NOT_IN_CONFIGURED_PROJECT',
    }
}
