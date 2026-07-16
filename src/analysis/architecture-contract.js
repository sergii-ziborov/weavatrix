// Executable target-architecture contract and no-regressions ratchet.
// The contract contains selectors and budgets only; verification is pure over graph metadata and never
// needs source bodies. Fingerprints deliberately exclude line numbers so edits do not churn baselines.
import {createHash} from 'node:crypto'
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {createRepoBoundary} from '../repo-path.js'

export const ARCHITECTURE_CONTRACT_V = 1
export const CONTRACT_PATHS = ['.weavatrix/architecture.json', '.weavatrix-architecture.json']

const RELATION_KIND = new Set(['runtime', 'type-only', 'compile-only', 'any'])
const ACTION = new Set(['allow', 'forbid'])
const ENFORCEMENT = new Set(['ratchet', 'strict', 'advisory'])
const safeId = (value, fallback = '') => {
    const text = String(value ?? '').trim()
    return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(text) ? text : fallback
}
const pathPrefix = (value) => {
    const text = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
    return text && !text.split('/').some((part) => !part || part === '.' || part === '..') ? text : null
}
const stringList = (value, sanitize, cap = 100) => [...new Set((Array.isArray(value) ? value : [])
    .slice(0, cap).map(sanitize).filter(Boolean))]
const finiteBudget = (value, fallback = null) => {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : fallback
}
const endpoint = (value) => value && typeof value === 'object' ? String(value.id) : String(value ?? '')
const isSymbol = (id) => String(id).includes('#')
const fileOf = (id, byId) => {
    const node = byId.get(String(id))
    if (node?.source_file) return String(node.source_file).replace(/\\/g, '/')
    return String(id).split('#')[0].replace(/\\/g, '/')
}
const stable = (value) => Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
        : JSON.stringify(value)
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex')

function sanitizeComponent(value, index) {
    const id = safeId(value?.id, `component-${index + 1}`)
    const paths = stringList(value?.paths ?? [value?.path], pathPrefix, 64)
    if (!paths.length) return null
    return {id, name: String(value?.name || id).slice(0, 128), paths}
}

function sanitizeRule(value, index) {
    const from = stringList(value?.from, (item) => item === '*' ? '*' : safeId(item), 64)
    const to = stringList(value?.to, (item) => item === '*' ? '*' : safeId(item), 64)
    if (!from.length || !to.length) return null
    return {
        id: safeId(value?.id, `dependency-${index + 1}`),
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

export function normalizeArchitectureContract(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('architecture contract must be an object')
    const components = (Array.isArray(input.components) ? input.components : [])
        .slice(0, 200).map(sanitizeComponent).filter(Boolean)
    const componentIds = new Set(components.map((item) => item.id))
    const dependencyRules = (Array.isArray(input.dependencyRules) ? input.dependencyRules : [])
        .slice(0, 500).map(sanitizeRule).filter(Boolean)
        .filter((rule) => [...rule.from, ...rule.to].every((id) => id === '*' || componentIds.has(id)))
    const rawBudgets = input.budgets && typeof input.budgets === 'object' ? input.budgets : {}
    const budgets = {
        runtimeCycles: finiteBudget(rawBudgets.runtimeCycles),
        maxFunctionLoc: finiteBudget(rawBudgets.maxFunctionLoc),
        maxFileLoc: finiteBudget(rawBudgets.maxFileLoc),
        maxCyclomatic: finiteBudget(rawBudgets.maxCyclomatic),
        maxParams: finiteBudget(rawBudgets.maxParams),
        maxRuntimeDependenciesPerComponent: finiteBudget(rawBudgets.maxRuntimeDependenciesPerComponent),
        maxModuleFiles: finiteBudget(rawBudgets.maxModuleFiles),
        minModuleCohesion: finiteBudget(rawBudgets.minModuleCohesion),
        maxModuleBoundaryRatio: finiteBudget(rawBudgets.maxModuleBoundaryRatio),
    }
    for (const key of Object.keys(budgets)) if (budgets[key] == null) delete budgets[key]
    const technologies = {
        required: stringList(input.technologies?.required, (item) => safeId(item), 100),
        forbidden: stringList(input.technologies?.forbidden, (item) => safeId(item), 100),
    }
    const baseline = input.ratchet?.baseline && typeof input.ratchet.baseline === 'object'
        ? {
            fingerprints: stringList(input.ratchet.baseline.fingerprints, (item) => /^[a-f0-9]{16,64}$/i.test(String(item)) ? String(item) : '', 5_000),
            metrics: Object.fromEntries(Object.entries(input.ratchet.baseline.metrics || {}).slice(0, 500)
                .map(([key, value]) => [safeId(key), finiteBudget(value)]).filter(([key, value]) => key && value != null)),
        }
        : {fingerprints: [], metrics: {}}
    const contract = {
        architectureContractV: ARCHITECTURE_CONTRACT_V,
        name: String(input.name || 'Target architecture').slice(0, 128),
        style: safeId(input.style, 'custom'),
        enforcement: ENFORCEMENT.has(input.enforcement) ? input.enforcement : 'ratchet',
        components,
        dependencyRules,
        budgets,
        technologies,
        exceptions: (Array.isArray(input.exceptions) ? input.exceptions : []).slice(0, 500).map(sanitizeException).filter(Boolean),
        ratchet: {baseline},
    }
    return {...contract, contractHash: hash(contract)}
}

export function loadArchitectureContract(repoRoot, graphPath) {
    const boundary = createRepoBoundary(repoRoot)
    for (const relative of CONTRACT_PATHS) {
        const resolved = boundary.resolve(relative)
        if (!resolved.ok || !existsSync(resolved.path)) continue
        try { return {contract: normalizeArchitectureContract(JSON.parse(readFileSync(resolved.path, 'utf8'))), source: relative} }
        catch (error) { return {contract: null, source: relative, error: error.message} }
    }
    const cached = graphPath ? join(dirname(graphPath), 'architecture.contract.json') : null
    if (cached && existsSync(cached)) {
        try { return {contract: normalizeArchitectureContract(JSON.parse(readFileSync(cached, 'utf8'))), source: 'hosted-cache'} }
        catch (error) { return {contract: null, source: 'hosted-cache', error: error.message} }
    }
    return {contract: null, source: null, error: null}
}

export function writeCachedArchitectureContract(graphPath, input) {
    if (!graphPath) throw new Error('graph path is required for hosted contract cache')
    const contract = normalizeArchitectureContract(input)
    const path = join(dirname(graphPath), 'architecture.contract.json')
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, JSON.stringify(contract, null, 2), 'utf8')
    return {path, contract}
}

function componentFor(file, components) {
    const normalized = String(file || '').replace(/\\/g, '/')
    let best = null
    for (const component of components) for (const prefix of component.paths) {
        if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) continue
        if (!best || prefix.length > best.prefix.length) best = {id: component.id, prefix}
    }
    return best?.id || '(unmapped)'
}

function relationKind(link) {
    if (link.typeOnly === true) return 'type-only'
    if (link.compileOnly === true) return 'compile-only'
    return 'runtime'
}

function runtimeFileGraph(graph) {
    const byId = new Map((graph.nodes || []).map((node) => [String(node.id), node]))
    const files = new Set((graph.nodes || []).filter((node) => !isSymbol(node.id)).map((node) => String(node.id)))
    const adjacency = new Map([...files].map((file) => [file, new Set()]))
    for (const link of graph.links || []) {
        if (relationKind(link) !== 'runtime' || !['imports', 're_exports'].includes(link.relation) || link.barrelProxy === true) continue
        const source = fileOf(endpoint(link.source), byId)
        const target = fileOf(endpoint(link.target), byId)
        if (source && target && source !== target && files.has(source) && files.has(target)) adjacency.get(source)?.add(target)
    }
    return adjacency
}

function stronglyConnected(adjacency) {
    let index = 0
    const indexes = new Map(), low = new Map(), stack = [], onStack = new Set(), out = []
    const visit = (node) => {
        indexes.set(node, index); low.set(node, index); index++; stack.push(node); onStack.add(node)
        for (const target of adjacency.get(node) || []) {
            if (!indexes.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))) }
            else if (onStack.has(target)) low.set(node, Math.min(low.get(node), indexes.get(target)))
        }
        if (low.get(node) !== indexes.get(node)) return
        const component = []
        while (stack.length) { const value = stack.pop(); onStack.delete(value); component.push(value); if (value === node) break }
        if (component.length > 1 || adjacency.get(node)?.has(node)) out.push(component.sort())
    }
    for (const node of [...adjacency.keys()].sort()) if (!indexes.has(node)) visit(node)
    return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
}

function violation(ruleId, kind, evidence, current, target) {
    const normalizedEvidence = String(evidence).replace(/:\d+(?=\b|$)/g, '')
    const fingerprint = hash({ruleId, kind, evidence: normalizedEvidence}).slice(0, 32)
    return {fingerprint, ruleId, kind, evidence, ...(current != null ? {current} : {}), ...(target != null ? {target} : {})}
}

function matchSelector(selector, value) { return selector.includes('*') || selector.includes(value) }

export function verifyArchitecture({graph, contract: rawContract, technologies = []}) {
    const contract = rawContract?.contractHash ? rawContract : normalizeArchitectureContract(rawContract)
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
    const links = Array.isArray(graph?.links) ? graph.links : []
    const byId = new Map(nodes.map((node) => [String(node.id), node]))
    const exceptions = new Set(contract.exceptions
        .filter((item) => !item.expires || item.expires >= new Date().toISOString().slice(0, 10))
        .map((item) => item.fingerprint))
    const violations = []
    const componentEdges = new Map()
    for (const link of links) {
        if (!['imports', 're_exports', 'calls', 'references'].includes(link.relation) || link.barrelProxy === true) continue
        const fromFile = fileOf(endpoint(link.source), byId), toFile = fileOf(endpoint(link.target), byId)
        if (!fromFile || !toFile || fromFile === toFile) continue
        const from = componentFor(fromFile, contract.components), to = componentFor(toFile, contract.components)
        if (from === to) continue
        const kind = relationKind(link)
        const key = `${from}\0${to}\0${kind}`
        const record = componentEdges.get(key) || {from, to, kind, count: 0, samples: []}
        record.count++
        if (record.samples.length < 5) record.samples.push(`${fromFile} -> ${toFile}`)
        componentEdges.set(key, record)
    }
    for (const edge of componentEdges.values()) {
        const applicable = contract.dependencyRules.filter((rule) =>
            rule.kinds.some((kind) => kind === 'any' || kind === edge.kind) && matchSelector(rule.from, edge.from))
        for (const rule of applicable) {
            if (rule.action === 'forbid' && matchSelector(rule.to, edge.to)) {
                violations.push(violation(rule.id, 'dependency', `${edge.from} -> ${edge.to} (${edge.kind})`, edge.count, 0))
            }
        }
        const allowRules = applicable.filter((rule) => rule.action === 'allow')
        if (allowRules.length && !allowRules.some((rule) => matchSelector(rule.to, edge.to))) {
            const ruleId = allowRules.map((rule) => rule.id).sort().join('+')
            violations.push(violation(ruleId, 'dependency', `${edge.from} -> ${edge.to} (${edge.kind}; outside allow-list)`, edge.count, 0))
        }
    }
    const runtimeCycles = stronglyConnected(runtimeFileGraph(graph))
    if (contract.budgets.runtimeCycles != null && runtimeCycles.length > contract.budgets.runtimeCycles) {
        violations.push(violation('budget.runtimeCycles', 'budget', `runtime cycles: ${runtimeCycles.length}`, runtimeCycles.length, contract.budgets.runtimeCycles))
    }
    const componentRuntimeTargets = new Map()
    for (const edge of componentEdges.values()) if (edge.kind === 'runtime') {
        const targets = componentRuntimeTargets.get(edge.from) || new Set(); targets.add(edge.to); componentRuntimeTargets.set(edge.from, targets)
    }
    if (contract.budgets.maxRuntimeDependenciesPerComponent != null) for (const [component, targets] of componentRuntimeTargets) {
        if (targets.size > contract.budgets.maxRuntimeDependenciesPerComponent) violations.push(violation(
            'budget.maxRuntimeDependenciesPerComponent', 'budget', `${component} runtime dependencies`, targets.size,
            contract.budgets.maxRuntimeDependenciesPerComponent,
        ))
    }
    const componentStats = new Map(contract.components.map((component) => [component.id, {
        files: new Set(), internalPairs: new Set(), boundaryPairs: new Set(),
    }]))
    for (const node of nodes.filter((item) => !isSymbol(item.id))) {
        const file = String(node.source_file || node.id).replace(/\\/g, '/')
        const component = componentFor(file, contract.components)
        componentStats.get(component)?.files.add(file)
    }
    const runtimePairs = new Set()
    for (const link of links) {
        if (relationKind(link) !== 'runtime' || !['imports', 're_exports', 'calls', 'references'].includes(link.relation) || link.barrelProxy === true) continue
        const source = fileOf(endpoint(link.source), byId), target = fileOf(endpoint(link.target), byId)
        if (!source || !target || source === target) continue
        const pair = `${source}\0${target}`
        if (runtimePairs.has(pair)) continue
        runtimePairs.add(pair)
        const from = componentFor(source, contract.components), to = componentFor(target, contract.components)
        if (from === to) componentStats.get(from)?.internalPairs.add(pair)
        else {
            componentStats.get(from)?.boundaryPairs.add(pair)
            componentStats.get(to)?.boundaryPairs.add(pair)
        }
    }
    for (const [component, stats] of componentStats) {
        const internal = stats.internalPairs.size, boundary = stats.boundaryPairs.size
        const cohesion = internal + boundary ? internal / (internal + boundary) : 1
        const boundaryRatio = internal + boundary ? boundary / (internal + boundary) : 0
        if (contract.budgets.maxModuleFiles != null && stats.files.size > contract.budgets.maxModuleFiles) violations.push(violation('budget.maxModuleFiles', 'budget', `${component} files`, stats.files.size, contract.budgets.maxModuleFiles))
        if (contract.budgets.minModuleCohesion != null && cohesion < contract.budgets.minModuleCohesion) violations.push(violation('budget.minModuleCohesion', 'budget', `${component} cohesion`, Number(cohesion.toFixed(4)), contract.budgets.minModuleCohesion))
        if (contract.budgets.maxModuleBoundaryRatio != null && boundaryRatio > contract.budgets.maxModuleBoundaryRatio) violations.push(violation('budget.maxModuleBoundaryRatio', 'budget', `${component} boundary ratio`, Number(boundaryRatio.toFixed(4)), contract.budgets.maxModuleBoundaryRatio))
    }
    for (const node of nodes) {
        const loc = finiteBudget(node?.complexity?.loc)
        const cyclomatic = finiteBudget(node?.complexity?.cyclomatic)
        const params = finiteBudget(node?.complexity?.params)
        const evidence = `${node.source_file || fileOf(node.id, byId)}#${node.label || node.id}`
        if (contract.budgets.maxFunctionLoc != null && loc != null && loc > contract.budgets.maxFunctionLoc) violations.push(violation('budget.maxFunctionLoc', 'budget', evidence, loc, contract.budgets.maxFunctionLoc))
        if (contract.budgets.maxCyclomatic != null && cyclomatic != null && cyclomatic > contract.budgets.maxCyclomatic) violations.push(violation('budget.maxCyclomatic', 'budget', evidence, cyclomatic, contract.budgets.maxCyclomatic))
        if (contract.budgets.maxParams != null && params != null && params > contract.budgets.maxParams) violations.push(violation('budget.maxParams', 'budget', evidence, params, contract.budgets.maxParams))
    }
    if (contract.budgets.maxFileLoc != null) for (const node of nodes.filter((item) => !isSymbol(item.id))) {
        const file = String(node.source_file || node.id)
        const maxEnd = nodes.filter((item) => item.source_file === file && isSymbol(item.id))
            .reduce((max, item) => Math.max(max, Number(String(item.source_end || '').replace(/^L/, '')) || 0), 0)
        if (maxEnd > contract.budgets.maxFileLoc) violations.push(violation('budget.maxFileLoc', 'budget', file, maxEnd, contract.budgets.maxFileLoc))
    }
    const techSet = new Set(technologies.map((item) => safeId(item)).filter(Boolean))
    for (const required of contract.technologies.required) if (!techSet.has(required)) violations.push(violation('technology.required', 'technology', `missing ${required}`))
    for (const forbidden of contract.technologies.forbidden) if (techSet.has(forbidden)) violations.push(violation('technology.forbidden', 'technology', `forbidden ${forbidden}`))

    const active = violations.filter((item) => !exceptions.has(item.fingerprint))
    const baseline = new Set(contract.ratchet.baseline.fingerprints)
    const current = new Set(active.map((item) => item.fingerprint))
    const fresh = active.filter((item) => !baseline.has(item.fingerprint))
    const existing = active.filter((item) => baseline.has(item.fingerprint))
    const fixed = [...baseline].filter((fingerprint) => !current.has(fingerprint))
    const status = contract.enforcement === 'advisory'
        ? 'ADVISORY'
        : contract.enforcement === 'strict'
            ? (active.length ? 'FAIL' : 'PASS')
            : (fresh.length ? 'FAIL' : 'PASS')
    const metrics = {
        runtimeCycles: runtimeCycles.length,
        violations: active.length,
        componentDependencies: componentEdges.size,
        mappedComponents: contract.components.length,
        componentFitness: Object.fromEntries([...componentStats].map(([component, stats]) => {
            const internal = stats.internalPairs.size, boundary = stats.boundaryPairs.size
            return [component, {files: stats.files.size, cohesion: internal + boundary ? Number((internal / (internal + boundary)).toFixed(4)) : 1, boundaryRatio: internal + boundary ? Number((boundary / (internal + boundary)).toFixed(4)) : 0}]
        })),
    }
    const result = {
        architectureVerificationV: 1,
        contractHash: contract.contractHash,
        status,
        enforcement: contract.enforcement,
        metrics,
        new: fresh,
        existing,
        fixed,
        excepted: violations.filter((item) => exceptions.has(item.fingerprint)),
        componentEdges: [...componentEdges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)),
        runtimeCycles: runtimeCycles.slice(0, 100),
    }
    return {...result, verificationHash: hash(result)}
}

export function contractForChange(contract, files = []) {
    const normalized = rawArray(files).map(pathPrefix).filter(Boolean)
    const components = [...new Set(normalized.map((file) => componentFor(file, contract.components)))]
    const rules = contract.dependencyRules.filter((rule) => components.some((component) => matchSelector(rule.from, component) || matchSelector(rule.to, component)))
    return {files: normalized, components, rules, budgets: contract.budgets, technologies: contract.technologies}
}

function rawArray(value) { return Array.isArray(value) ? value.slice(0, 200) : [] }
