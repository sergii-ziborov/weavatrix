import {architectureHash} from './contract-schema.js'

export const isSymbolNode = (id) => String(id).includes('#')
const endpointId = (value) => value && typeof value === 'object' ? String(value.id) : String(value ?? '')

export function fileOfNode(id, byId) {
    const node = byId.get(String(id))
    if (node?.source_file) return String(node.source_file).replace(/\\/g, '/')
    return String(id).split('#')[0].replace(/\\/g, '/')
}

export function componentForFile(file, components) {
    const normalized = String(file || '').replace(/\\/g, '/')
    let best = null
    for (const component of components) for (const prefix of component.paths) {
        if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) continue
        if (!best || prefix.length > best.prefix.length) best = {id: component.id, prefix}
    }
    return best?.id || '(unmapped)'
}

export function relationKind(link) {
    if (link.typeOnly === true) return 'type-only'
    if (link.compileOnly === true) return 'compile-only'
    return 'runtime'
}

export function runtimeFileGraph(graph) {
    const byId = new Map((graph.nodes || []).map((node) => [String(node.id), node]))
    const files = new Set((graph.nodes || []).filter((node) => !isSymbolNode(node.id)).map((node) => String(node.id)))
    const adjacency = new Map([...files].map((file) => [file, new Set()]))
    for (const link of graph.links || []) {
        if (relationKind(link) !== 'runtime' || !['imports', 're_exports'].includes(link.relation) || link.barrelProxy === true) continue
        const source = fileOfNode(endpointId(link.source), byId)
        const target = fileOfNode(endpointId(link.target), byId)
        if (source && target && source !== target && files.has(source) && files.has(target)) adjacency.get(source)?.add(target)
    }
    return adjacency
}

export function stronglyConnected(adjacency) {
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
        while (stack.length) {
            const value = stack.pop()
            onStack.delete(value)
            component.push(value)
            if (value === node) break
        }
        if (component.length > 1 || adjacency.get(node)?.has(node)) out.push(component.sort())
    }
    for (const node of [...adjacency.keys()].sort()) if (!indexes.has(node)) visit(node)
    return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
}

export function architectureViolation(ruleId, kind, evidence, current, target) {
    const normalizedEvidence = String(evidence).replace(/:\d+(?=\b|$)/g, '')
    const fingerprint = architectureHash({ruleId, kind, evidence: normalizedEvidence}).slice(0, 32)
    return {fingerprint, ruleId, kind, evidence, ...(current != null ? {current} : {}), ...(target != null ? {target} : {})}
}

export const matchComponentSelector = (selector, value) => selector.includes('*') || selector.includes(value)

export function collectComponentEdges(graph, contract) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
    const links = Array.isArray(graph?.links) ? graph.links : []
    const byId = new Map(nodes.map((node) => [String(node.id), node]))
    const componentEdges = new Map()
    for (const link of links) {
        if (!['imports', 're_exports', 'calls', 'references'].includes(link.relation) || link.barrelProxy === true) continue
        const fromFile = fileOfNode(endpointId(link.source), byId)
        const toFile = fileOfNode(endpointId(link.target), byId)
        if (!fromFile || !toFile || fromFile === toFile) continue
        const from = componentForFile(fromFile, contract.components)
        const to = componentForFile(toFile, contract.components)
        if (from === to) continue
        const kind = relationKind(link)
        const key = `${from}\0${to}\0${kind}`
        const record = componentEdges.get(key) || {from, to, kind, count: 0, samples: []}
        record.count++
        if (record.samples.length < 5) record.samples.push(`${fromFile} -> ${toFile}`)
        componentEdges.set(key, record)
    }
    return {nodes, links, byId, componentEdges}
}

export function collectComponentFitness(nodes, links, byId, contract) {
    const stats = new Map(contract.components.map((component) => [component.id, {
        files: new Set(), internalPairs: new Set(), boundaryPairs: new Set(),
    }]))
    for (const node of nodes.filter((item) => !isSymbolNode(item.id))) {
        const file = String(node.source_file || node.id).replace(/\\/g, '/')
        stats.get(componentForFile(file, contract.components))?.files.add(file)
    }
    const runtimePairs = new Set()
    for (const link of links) {
        if (relationKind(link) !== 'runtime' || !['imports', 're_exports', 'calls', 'references'].includes(link.relation) || link.barrelProxy === true) continue
        const source = fileOfNode(endpointId(link.source), byId), target = fileOfNode(endpointId(link.target), byId)
        if (!source || !target || source === target) continue
        const pair = `${source}\0${target}`
        if (runtimePairs.has(pair)) continue
        runtimePairs.add(pair)
        const from = componentForFile(source, contract.components), to = componentForFile(target, contract.components)
        if (from === to) stats.get(from)?.internalPairs.add(pair)
        else {
            stats.get(from)?.boundaryPairs.add(pair)
            stats.get(to)?.boundaryPairs.add(pair)
        }
    }
    return stats
}
