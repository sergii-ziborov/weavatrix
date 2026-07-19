import {isStructuralRelation} from '../../graph/relations.js'

// Shared reverse dependency walk for get_dependents and change_impact. Keep one
// representation so runtime/compile-time depth and edge provenance cannot drift
// between the two public tools.
export function reverseReach(g, seeds, maxDepth) {
    const states = new Map([...seeds].map((id) => [String(id), {
        runtimeDepth: 0, runtimeRelation: null, runtimeProvenance: null,
        compileDepth: null, compileRelation: null, compileProvenance: null,
    }]))
    const frontier = [...seeds].map((id) => ({id: String(id), depth: 0, compileOnly: false}))
    for (let cursor = 0; cursor < frontier.length; cursor++) {
        const current = frontier[cursor]
        if (current.depth >= maxDepth) continue
        for (const edge of g.inn.get(current.id) || []) {
            if (isStructuralRelation(edge.relation) || edge.barrelProxy === true) continue
            const id = String(edge.id)
            const compileOnly = current.compileOnly || edge.typeOnly === true || edge.compileOnly === true
            const depth = current.depth + 1
            const entry = states.get(id) || {
                runtimeDepth: null, runtimeRelation: null, runtimeProvenance: null,
                compileDepth: null, compileRelation: null, compileProvenance: null,
            }
            const depthKey = compileOnly ? 'compileDepth' : 'runtimeDepth'
            const relationKey = compileOnly ? 'compileRelation' : 'runtimeRelation'
            const provenanceKey = compileOnly ? 'compileProvenance' : 'runtimeProvenance'
            if (entry[depthKey] != null && entry[depthKey] <= depth) continue
            entry[depthKey] = depth
            entry[relationKey] = edge.relation || 'rel'
            entry[provenanceKey] = edge.provenance || 'UNKNOWN'
            states.set(id, entry)
            frontier.push({id, depth, compileOnly})
        }
    }
    return new Map([...states].map(([id, entry]) => [id, {
        ...entry,
        depth: entry.runtimeDepth ?? entry.compileDepth ?? 0,
        compileOnly: entry.runtimeDepth == null,
        relation: entry.runtimeDepth != null ? entry.runtimeRelation : entry.compileRelation,
        provenance: entry.runtimeDepth != null ? entry.runtimeProvenance : entry.compileProvenance,
    }]))
}
