import {ENTRY_FILE} from '../dead-check.js'
import {fileOfId, graphEndpointId} from '../../graph/node-id.js'

const TEST_FILE_RE = /(^|[/])(test|tests|__tests__|spec|e2e|__mocks__)([/]|$)|[._-](test|spec)\.[a-z0-9]+$/i
const NON_CODE_RE = /\.(json|ya?ml|sh|ps1|md|txt|html?|css|scss|less)$|(^|[/])(dockerfile|containerfile)/i
const dirOf = (file) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''

export function buildFileImportGraph(graph, {includeTypeOnly = false, includeCompileOnly = false} = {}) {
    const fileIds = new Set()
    for (const node of graph.nodes || []) if (!String(node.id).includes('#')) fileIds.add(String(node.id))
    const runtimeAdj = new Map(), allAdj = new Map()
    const edges = [], allEdges = [], typeOnlyEdges = [], compileOnlyEdges = [], compileTimeEdges = []
    const runtimeSeen = new Set(), allSeen = new Set(), typeSeen = new Set(), compileSeen = new Set(), compileTimeSeen = new Set()
    const add = (map, source, target) => {
        let targets = map.get(source)
        if (!targets) map.set(source, (targets = new Set()))
        targets.add(target)
    }
    for (const link of graph.links || []) {
        if (link.relation !== 'imports' && link.relation !== 're_exports') continue
        const source = graphEndpointId(link.source), target = graphEndpointId(link.target)
        if (!fileIds.has(source) || !fileIds.has(target) || source === target) continue
        if (source.endsWith('.go') && target.endsWith('.go') && dirOf(source) === dirOf(target)) continue
        const key = `${source}\0${target}`
        if (!allSeen.has(key)) { allSeen.add(key); add(allAdj, source, target); allEdges.push([source, target]) }
        if (link.typeOnly === true || link.compileOnly === true) {
            if (link.typeOnly === true && !typeSeen.has(key)) { typeSeen.add(key); typeOnlyEdges.push([source, target]) }
            if (link.compileOnly === true && !compileSeen.has(key)) { compileSeen.add(key); compileOnlyEdges.push([source, target]) }
            if (!compileTimeSeen.has(key)) { compileTimeSeen.add(key); compileTimeEdges.push([source, target]) }
            continue
        }
        if (!runtimeSeen.has(key)) { runtimeSeen.add(key); add(runtimeAdj, source, target); edges.push([source, target]) }
    }
    return {
        fileIds,
        adj: includeTypeOnly || includeCompileOnly ? allAdj : runtimeAdj,
        edges: includeTypeOnly || includeCompileOnly ? allEdges : edges,
        runtimeAdj,
        runtimeEdges: edges,
        allAdj,
        allEdges,
        typeOnlyEdges: typeOnlyEdges.filter(([a, b]) => !runtimeSeen.has(`${a}\0${b}`)),
        compileOnlyEdges: compileOnlyEdges.filter(([a, b]) => !runtimeSeen.has(`${a}\0${b}`)),
        compileTimeEdges: compileTimeEdges.filter(([a, b]) => !runtimeSeen.has(`${a}\0${b}`)),
    }
}

// Iterative Tarjan: repository graphs can be deep enough to overflow recursive JavaScript.
export function findSccs(adjacency) {
    const index = new Map(), low = new Map(), onStack = new Set(), nodes = []
    let counter = 0
    const components = []
    for (const root of adjacency.keys()) {
        if (index.has(root)) continue
        index.set(root, counter); low.set(root, counter); counter++
        nodes.push(root); onStack.add(root)
        const stack = [{value: root, child: 0, neighbors: [...(adjacency.get(root) || [])]}]
        while (stack.length) {
            const frame = stack[stack.length - 1]
            if (frame.child < frame.neighbors.length) {
                const next = frame.neighbors[frame.child++]
                if (!index.has(next)) {
                    index.set(next, counter); low.set(next, counter); counter++
                    nodes.push(next); onStack.add(next)
                    stack.push({value: next, child: 0, neighbors: [...(adjacency.get(next) || [])]})
                } else if (onStack.has(next)) low.set(frame.value, Math.min(low.get(frame.value), index.get(next)))
                continue
            }
            stack.pop()
            if (stack.length) {
                const parent = stack[stack.length - 1]
                low.set(parent.value, Math.min(low.get(parent.value), low.get(frame.value)))
            }
            if (low.get(frame.value) !== index.get(frame.value)) continue
            const component = []
            let value
            do { value = nodes.pop(); onStack.delete(value); component.push(value) } while (value !== frame.value)
            if (component.length > 1) components.push(component)
        }
    }
    return components
}

export function representativeCycle(adjacency, component) {
    const members = new Set(component)
    const start = [...component].sort()[0]
    const previous = new Map([[start, null]])
    const queue = [start]
    while (queue.length) {
        const current = queue.shift()
        for (const next of [...(adjacency.get(current) || [])].sort()) {
            if (next === start) {
                const path = []
                for (let value = current; value != null; value = previous.get(value)) path.push(value)
                return [...path.reverse(), start]
            }
            if (!members.has(next) || previous.has(next)) continue
            previous.set(next, current)
            queue.push(next)
        }
    }
    const fallback = [...component].sort()
    return [...fallback, fallback[0]]
}

export function findOrphans(graph, {entrySet = new Set(), externalImportFiles = new Set()} = {}) {
    const degree = new Map()
    for (const link of graph.links || []) {
        if (link.relation === 'contains') continue
        const source = fileOfId(graphEndpointId(link.source)), target = fileOfId(graphEndpointId(link.target))
        if (source === target) continue
        degree.set(source, (degree.get(source) || 0) + 1)
        degree.set(target, (degree.get(target) || 0) + 1)
    }
    const out = []
    for (const node of graph.nodes || []) {
        const id = String(node.id)
        if (id.includes('#') || (degree.get(id) || 0) > 0) continue
        const file = node.source_file
        if (entrySet.has(file) || ENTRY_FILE.test(file) || TEST_FILE_RE.test(file) || NON_CODE_RE.test(file)) continue
        out.push({file, importsExternals: externalImportFiles.has(file)})
    }
    return out
}

export function globToRe(glob) {
    const parts = String(glob).split('**').map((part) => part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    let source = parts.join('.*')
    source = source.replace(/\/\.\*\//g, '/(?:.*/)?').replace(/^\.\*\//, '(?:.*/)?')
    return new RegExp(`^${source}$`)
}

export function checkBoundaries(edges, rules = {}) {
    const violations = []
    const forbidden = (rules.forbidden || []).map((rule) => ({...rule, fromRe: globToRe(rule.from), toRe: globToRe(rule.to)}))
    const allowedOnly = (rules.allowedOnly || []).map((rule) => ({
        ...rule,
        fromRe: globToRe(rule.from),
        toRes: (Array.isArray(rule.to) ? rule.to : [rule.to]).map(globToRe),
    }))
    for (const [source, target] of edges) {
        for (const rule of forbidden) if (rule.fromRe.test(source) && rule.toRe.test(target)) {
            violations.push({name: rule.name, comment: rule.comment || '', severity: rule.severity, from: source, to: target, kind: 'forbidden'})
        }
        for (const rule of allowedOnly) if (rule.fromRe.test(source) && !rule.toRes.some((regexp) => regexp.test(target))) {
            violations.push({name: rule.name, comment: rule.comment || '', severity: rule.severity, from: source, to: target, kind: 'allowedOnly'})
        }
    }
    return violations
}
