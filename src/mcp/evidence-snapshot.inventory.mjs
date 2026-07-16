import {
    CAPS, STATE, VERDICT, addIf, bounded, compareText, metadataString, normalizeCheckState,
    repoRelativePath, safeToken,
} from './evidence-snapshot.common.mjs'

const FIXED_PACKAGE_SOURCES = new Set([
    'package-lock', 'yarn-lock', 'requirements', 'venv', 'poetry-lock', 'uv-lock',
    'pipfile-lock', 'go-sum', 'go-mod', 'node_modules',
])
const PACKAGE_SOURCE_FILE = /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|requirements[\w.-]*\.(?:txt|in)|poetry\.lock|uv\.lock|Pipfile\.lock|go\.(?:mod|sum))$/i

function sanitizeBadge(category, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const id = safeToken(value.id, 128)
    if (!id) return null
    const out = {category, id}
    addIf(out, 'name', metadataString(value.name || value.label, 128))
    addIf(out, 'kind', safeToken(value.kind, 64))
    addIf(out, 'title', metadataString(value.title, 128))
    addIf(out, 'version', safeToken(value.version, 64))
    return out
}

export function buildTechnologiesSection(stack, stackError) {
    if (stackError) {
        return {
            state: STATE.ERROR,
            verdict: VERDICT.UNKNOWN,
            completeness: {badges: {total: 0, returned: 0, truncated: false}, reasons: ['STACK_DETECTION_ERROR']},
            badges: [],
        }
    }
    const categories = ['languages', 'runtimes', 'tests', 'infra', 'deploy']
    const facts = categories.flatMap((category) => (Array.isArray(stack?.[category]) ? stack[category] : [])
        .map((badge) => sanitizeBadge(category, badge)).filter(Boolean))
        .sort((a, b) => compareText(a.category, b.category) || compareText(a.id, b.id))
    const badges = bounded(facts, CAPS.stackBadges)
    return {
        state: STATE.PARTIAL,
        verdict: VERDICT.UNKNOWN,
        completeness: {
            badges: badges.completeness,
            reasons: ['MANIFEST_AND_FILE_HEURISTICS_ONLY', 'INFRA_IMPORT_DETECTION_DISABLED'],
        },
        badges: badges.items,
    }
}

function packageSource(value) {
    const raw = metadataString(value, 512)
    if (!raw) return undefined
    const normalized = raw.replace(/\\/g, '/')
    if (FIXED_PACKAGE_SOURCES.has(normalized)) return normalized
    const relative = repoRelativePath(normalized, 512)
    return relative && PACKAGE_SOURCE_FILE.test(relative) ? relative : undefined
}

function sanitizePackage(value) {
    const name = safeToken(value?.name)
    const version = safeToken(value?.version, 128)
    const ecosystem = safeToken(value?.ecosystem, 64)
    const source = packageSource(value?.source)
    if (!name || !version || !ecosystem || !source) return null
    return {name, version, ecosystem, dev: value.dev === true, source}
}

function buildDirectUsage(externalImports) {
    const usage = new Map()
    for (const entry of Array.isArray(externalImports) ? externalImports : []) {
        if (!entry || typeof entry !== 'object' || entry.builtin === true || entry.unresolved === true) continue
        const name = safeToken(entry.pkg)
        const ecosystem = safeToken(entry.ecosystem || 'npm', 64)
        const file = repoRelativePath(entry.file)
        if (!name || !ecosystem || !file) continue
        const key = `${ecosystem}\0${name}`
        let fact = usage.get(key)
        if (!fact) usage.set(key, (fact = {name, ecosystem, importCount: 0, files: new Set(), kinds: new Set()}))
        fact.importCount++
        fact.files.add(file)
        const kind = safeToken(entry.kind, 64)
        if (kind) fact.kinds.add(kind)
    }
    return [...usage.values()].map((fact) => {
        const files = [...fact.files].sort(compareText)
        return {
            name: fact.name,
            ecosystem: fact.ecosystem,
            importCount: fact.importCount,
            fileCount: files.length,
            files: files.slice(0, CAPS.usageFiles),
            filesTruncated: files.length > CAPS.usageFiles,
            kinds: [...fact.kinds].sort(compareText),
        }
    }).sort((a, b) => compareText(a.ecosystem, b.ecosystem) || compareText(a.name, b.name))
}

export function buildPackagesSection(installedResult, installedError, graph, audit) {
    if (installedError) {
        return {
            state: STATE.ERROR,
            verdict: VERDICT.UNKNOWN,
            completeness: {reasons: ['PACKAGE_INVENTORY_ERROR']},
            checks: {osv: normalizeCheckState(audit?.checks?.osv?.status), malware: normalizeCheckState(audit?.checks?.malware?.status)},
            inventory: [],
            directUsage: [],
        }
    }
    const inventory = bounded((installedResult?.installed || []).map(sanitizePackage).filter(Boolean)
        .sort((a, b) => compareText(a.ecosystem, b.ecosystem) || compareText(a.name, b.name) ||
            compareText(a.version, b.version) || compareText(a.source, b.source) || Number(a.dev) - Number(b.dev)),
    CAPS.packages)
    const usage = bounded(buildDirectUsage(graph?.externalImports), CAPS.directUsage)
    const packageRules = new Set(['unused-dep', 'missing-dep', 'duplicate-dep', 'lockfile-drift', 'known-vuln', 'malicious-package', 'typosquat'])
    const packageFailure = (audit?.findings || []).some((finding) => packageRules.has(finding?.rule))
    return {
        state: STATE.PARTIAL,
        verdict: packageFailure ? VERDICT.FAIL : VERDICT.UNKNOWN,
        completeness: {
            inventory: inventory.completeness,
            directUsage: usage.completeness,
            reasons: ['TRANSITIVE_PACKAGE_EDGES_NOT_AVAILABLE'],
        },
        checks: {
            osv: normalizeCheckState(audit?.checks?.osv?.status),
            malware: normalizeCheckState(audit?.checks?.malware?.status),
        },
        inventory: inventory.items,
        directUsage: usage.items,
    }
}
