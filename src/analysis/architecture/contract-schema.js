import {createHash} from 'node:crypto'

export const ARCHITECTURE_CONTRACT_V = 1

const RELATION_KIND = new Set(['runtime', 'type-only', 'compile-only', 'any'])
const ACTION = new Set(['allow', 'forbid'])
const ENFORCEMENT = new Set(['ratchet', 'strict', 'advisory'])

export const safeArchitectureId = (value, fallback = '') => {
    const text = String(value ?? '').trim()
    return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(text) ? text : fallback
}

export const architecturePathPrefix = (value) => {
    const text = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
    return text && !text.split('/').some((part) => !part || part === '.' || part === '..') ? text : null
}

export const finiteArchitectureBudget = (value, fallback = null) => {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : fallback
}

const stringList = (value, sanitize, cap = 100) => [...new Set((Array.isArray(value) ? value : [])
    .slice(0, cap).map(sanitize).filter(Boolean))]

const stable = (value) => Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
        : JSON.stringify(value)

export const architectureHash = (value) => createHash('sha256').update(stable(value)).digest('hex')

function sanitizeComponent(value, index) {
    const id = safeArchitectureId(value?.id, `component-${index + 1}`)
    const paths = stringList(value?.paths ?? [value?.path], architecturePathPrefix, 64)
    if (!paths.length) return null
    return {id, name: String(value?.name || id).slice(0, 128), paths}
}

function sanitizeRule(value, index) {
    const from = stringList(value?.from, (item) => item === '*' ? '*' : safeArchitectureId(item), 64)
    const to = stringList(value?.to, (item) => item === '*' ? '*' : safeArchitectureId(item), 64)
    if (!from.length || !to.length) return null
    return {
        id: safeArchitectureId(value?.id, `dependency-${index + 1}`),
        action: ACTION.has(value?.action) ? value.action : 'forbid',
        kinds: stringList(value?.kinds ?? ['runtime'], (kind) => RELATION_KIND.has(kind) ? kind : '', 4),
        from,
        to,
        ...(value?.reason ? {reason: String(value.reason).slice(0, 300)} : {}),
    }
}

function sanitizeException(value) {
    const fingerprint = /^[a-f0-9]{16,64}$/i.test(String(value?.fingerprint || '')) ? String(value.fingerprint) : null
    if (!fingerprint) return null
    const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(value?.expires || '')) ? String(value.expires) : null
    return {fingerprint, reason: String(value?.reason || '').slice(0, 300), ...(expires ? {expires} : {})}
}

function normalizeBudgets(raw = {}) {
    const budgets = {
        runtimeCycles: finiteArchitectureBudget(raw.runtimeCycles),
        maxFunctionLoc: finiteArchitectureBudget(raw.maxFunctionLoc),
        maxFileLoc: finiteArchitectureBudget(raw.maxFileLoc),
        maxCyclomatic: finiteArchitectureBudget(raw.maxCyclomatic),
        maxParams: finiteArchitectureBudget(raw.maxParams),
        maxRuntimeDependenciesPerComponent: finiteArchitectureBudget(raw.maxRuntimeDependenciesPerComponent),
        maxModuleFiles: finiteArchitectureBudget(raw.maxModuleFiles),
        minModuleCohesion: finiteArchitectureBudget(raw.minModuleCohesion),
        maxModuleBoundaryRatio: finiteArchitectureBudget(raw.maxModuleBoundaryRatio),
    }
    for (const key of Object.keys(budgets)) if (budgets[key] == null) delete budgets[key]
    return budgets
}

export function normalizeArchitectureContract(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('architecture contract must be an object')
    const components = (Array.isArray(input.components) ? input.components : [])
        .slice(0, 200).map(sanitizeComponent).filter(Boolean)
    const componentIds = new Set(components.map((item) => item.id))
    const dependencyRules = (Array.isArray(input.dependencyRules) ? input.dependencyRules : [])
        .slice(0, 500).map(sanitizeRule).filter(Boolean)
        .filter((rule) => [...rule.from, ...rule.to].every((id) => id === '*' || componentIds.has(id)))
    const baseline = input.ratchet?.baseline && typeof input.ratchet.baseline === 'object'
        ? {
            fingerprints: stringList(input.ratchet.baseline.fingerprints, (item) => /^[a-f0-9]{16,64}$/i.test(String(item)) ? String(item) : '', 5_000),
            metrics: Object.fromEntries(Object.entries(input.ratchet.baseline.metrics || {}).slice(0, 500)
                .map(([key, value]) => [safeArchitectureId(key), finiteArchitectureBudget(value)]).filter(([key, value]) => key && value != null)),
        }
        : {fingerprints: [], metrics: {}}
    const contract = {
        architectureContractV: ARCHITECTURE_CONTRACT_V,
        name: String(input.name || 'Target architecture').slice(0, 128),
        style: safeArchitectureId(input.style, 'custom'),
        enforcement: ENFORCEMENT.has(input.enforcement) ? input.enforcement : 'ratchet',
        components,
        dependencyRules,
        budgets: normalizeBudgets(input.budgets),
        technologies: {
            required: stringList(input.technologies?.required, (item) => safeArchitectureId(item), 100),
            forbidden: stringList(input.technologies?.forbidden, (item) => safeArchitectureId(item), 100),
        },
        exceptions: (Array.isArray(input.exceptions) ? input.exceptions : []).slice(0, 500).map(sanitizeException).filter(Boolean),
        ratchet: {baseline},
    }
    return {...contract, contractHash: architectureHash(contract)}
}
