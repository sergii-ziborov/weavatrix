import {
    architectureHash,
    architecturePathPrefix,
    finiteArchitectureBudget,
    normalizeArchitectureContract,
} from './contract-schema.js'
import {
    architectureViolation as violation,
    collectComponentEdges,
    collectComponentFitness,
    componentForFile,
    fileOfNode,
    isSymbolNode,
    matchComponentSelector as matches,
    runtimeFileGraph,
    stronglyConnected,
} from './contract-graph.js'

function dependencyViolations(componentEdges, contract) {
    const violations = []
    for (const edge of componentEdges.values()) {
        const applicable = contract.dependencyRules.filter((rule) =>
            rule.kinds.some((kind) => kind === 'any' || kind === edge.kind) && matches(rule.from, edge.from))
        for (const rule of applicable) if (rule.action === 'forbid' && matches(rule.to, edge.to)) {
            violations.push(violation(rule.id, 'dependency', `${edge.from} -> ${edge.to} (${edge.kind})`, edge.count, 0))
        }
        const allowRules = applicable.filter((rule) => rule.action === 'allow')
        if (allowRules.length && !allowRules.some((rule) => matches(rule.to, edge.to))) {
            const ruleId = allowRules.map((rule) => rule.id).sort().join('+')
            violations.push(violation(ruleId, 'dependency', `${edge.from} -> ${edge.to} (${edge.kind}; outside allow-list)`, edge.count, 0))
        }
    }
    return violations
}

function componentBudgetViolations(componentEdges, stats, contract) {
    const violations = []
    const targetsByComponent = new Map()
    for (const edge of componentEdges.values()) if (edge.kind === 'runtime') {
        const targets = targetsByComponent.get(edge.from) || new Set()
        targets.add(edge.to)
        targetsByComponent.set(edge.from, targets)
    }
    if (contract.budgets.maxRuntimeDependenciesPerComponent != null) for (const [component, targets] of targetsByComponent) {
        if (targets.size > contract.budgets.maxRuntimeDependenciesPerComponent) violations.push(violation(
            'budget.maxRuntimeDependenciesPerComponent', 'budget', `${component} runtime dependencies`, targets.size,
            contract.budgets.maxRuntimeDependenciesPerComponent,
        ))
    }
    for (const [component, item] of stats) {
        const internal = item.internalPairs.size, boundary = item.boundaryPairs.size
        const cohesion = internal + boundary ? internal / (internal + boundary) : 1
        const boundaryRatio = internal + boundary ? boundary / (internal + boundary) : 0
        if (contract.budgets.maxModuleFiles != null && item.files.size > contract.budgets.maxModuleFiles) {
            violations.push(violation('budget.maxModuleFiles', 'budget', `${component} files`, item.files.size, contract.budgets.maxModuleFiles))
        }
        if (contract.budgets.minModuleCohesion != null && cohesion < contract.budgets.minModuleCohesion) {
            violations.push(violation('budget.minModuleCohesion', 'budget', `${component} cohesion`, Number(cohesion.toFixed(4)), contract.budgets.minModuleCohesion))
        }
        if (contract.budgets.maxModuleBoundaryRatio != null && boundaryRatio > contract.budgets.maxModuleBoundaryRatio) {
            violations.push(violation('budget.maxModuleBoundaryRatio', 'budget', `${component} boundary ratio`, Number(boundaryRatio.toFixed(4)), contract.budgets.maxModuleBoundaryRatio))
        }
    }
    return violations
}

function codeBudgetViolations(nodes, byId, contract) {
    const violations = []
    for (const node of nodes) {
        const loc = finiteArchitectureBudget(node?.complexity?.loc)
        const cyclomatic = finiteArchitectureBudget(node?.complexity?.cyclomatic)
        const params = finiteArchitectureBudget(node?.complexity?.params)
        const evidence = `${node.source_file || fileOfNode(node.id, byId)}#${node.label || node.id}`
        if (contract.budgets.maxFunctionLoc != null && loc != null && loc > contract.budgets.maxFunctionLoc) {
            violations.push(violation('budget.maxFunctionLoc', 'budget', evidence, loc, contract.budgets.maxFunctionLoc))
        }
        if (contract.budgets.maxCyclomatic != null && cyclomatic != null && cyclomatic > contract.budgets.maxCyclomatic) {
            violations.push(violation('budget.maxCyclomatic', 'budget', evidence, cyclomatic, contract.budgets.maxCyclomatic))
        }
        if (contract.budgets.maxParams != null && params != null && params > contract.budgets.maxParams) {
            violations.push(violation('budget.maxParams', 'budget', evidence, params, contract.budgets.maxParams))
        }
    }
    if (contract.budgets.maxFileLoc != null) for (const node of nodes.filter((item) => !isSymbolNode(item.id))) {
        const file = String(node.source_file || node.id)
        const physicalLoc = finiteArchitectureBudget(node.physical_loc)
        if (physicalLoc != null && physicalLoc > contract.budgets.maxFileLoc) {
            violations.push(violation('budget.maxFileLoc', 'budget', file, physicalLoc, contract.budgets.maxFileLoc))
        }
    }
    return violations
}

function technologyViolations(contract, technologies) {
    const techSet = new Set(technologies.map((item) => String(item ?? '').trim()).filter(Boolean))
    const violations = []
    for (const required of contract.technologies.required) if (!techSet.has(required)) {
        violations.push(violation('technology.required', 'technology', `missing ${required}`))
    }
    for (const forbidden of contract.technologies.forbidden) if (techSet.has(forbidden)) {
        violations.push(violation('technology.forbidden', 'technology', `forbidden ${forbidden}`))
    }
    return violations
}

const componentFitnessMetrics = (stats) => Object.fromEntries([...stats].map(([component, item]) => {
    const internal = item.internalPairs.size, boundary = item.boundaryPairs.size
    return [component, {
        files: item.files.size,
        cohesion: internal + boundary ? Number((internal / (internal + boundary)).toFixed(4)) : 1,
        boundaryRatio: internal + boundary ? Number((boundary / (internal + boundary)).toFixed(4)) : 0,
    }]
}))

export function verifyArchitecture({graph, contract: rawContract, technologies = []}) {
    const contract = rawContract?.contractHash ? rawContract : normalizeArchitectureContract(rawContract)
    const {nodes, links, byId, componentEdges} = collectComponentEdges(graph, contract)
    const stats = collectComponentFitness(nodes, links, byId, contract)
    const runtimeCycles = stronglyConnected(runtimeFileGraph(graph))
    const violations = [
        ...dependencyViolations(componentEdges, contract),
        ...componentBudgetViolations(componentEdges, stats, contract),
        ...codeBudgetViolations(nodes, byId, contract),
        ...technologyViolations(contract, technologies),
    ]
    if (contract.budgets.runtimeCycles != null && runtimeCycles.length > contract.budgets.runtimeCycles) {
        violations.push(violation('budget.runtimeCycles', 'budget', `runtime cycles: ${runtimeCycles.length}`, runtimeCycles.length, contract.budgets.runtimeCycles))
    }
    const exceptions = new Set(contract.exceptions
        .filter((item) => !item.expires || item.expires >= new Date().toISOString().slice(0, 10))
        .map((item) => item.fingerprint))
    const active = violations.filter((item) => !exceptions.has(item.fingerprint))
    const baseline = new Set(contract.ratchet.baseline.fingerprints)
    const current = new Set(active.map((item) => item.fingerprint))
    const fresh = active.filter((item) => !baseline.has(item.fingerprint))
    const existing = active.filter((item) => baseline.has(item.fingerprint))
    const fixed = [...baseline].filter((fingerprint) => !current.has(fingerprint))
    const status = contract.enforcement === 'advisory'
        ? 'ADVISORY'
        : contract.enforcement === 'strict' ? (active.length ? 'FAIL' : 'PASS') : (fresh.length ? 'FAIL' : 'PASS')
    const result = {
        architectureVerificationV: 1,
        contractHash: contract.contractHash,
        status,
        enforcement: contract.enforcement,
        metrics: {
            runtimeCycles: runtimeCycles.length,
            violations: active.length,
            componentDependencies: componentEdges.size,
            mappedComponents: contract.components.length,
            componentFitness: componentFitnessMetrics(stats),
        },
        new: fresh,
        existing,
        fixed,
        excepted: violations.filter((item) => exceptions.has(item.fingerprint)),
        componentEdges: [...componentEdges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)),
        runtimeCycles: runtimeCycles.slice(0, 100),
    }
    return {...result, verificationHash: architectureHash(result)}
}

export function contractForChange(contract, files = []) {
    const normalized = (Array.isArray(files) ? files.slice(0, 200) : []).map(architecturePathPrefix).filter(Boolean)
    const components = [...new Set(normalized.map((file) => componentForFile(file, contract.components)))]
    const rules = contract.dependencyRules.filter((rule) => components.some((component) => matches(rule.from, component) || matches(rule.to, component)))
    return {files: normalized, components, rules, budgets: contract.budgets, technologies: contract.technologies}
}
