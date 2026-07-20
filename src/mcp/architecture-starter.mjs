// Adaptive, source-free architecture starter. It proposes component territories and separately
// reports observed dependency directions; observations never become enforceable policy implicitly.
import {normalizeArchitectureContract} from '../analysis/architecture-contract.js'
import {createPathClassifier, hasPathClass} from '../path-classification.js'

export const PROVISIONAL_BUDGETS = Object.freeze({
    runtimeCycles: 0,
    maxFileLoc: 300,
    maxFunctionLoc: 120,
    maxCyclomatic: 15,
    maxModuleFiles: 80,
    minModuleCohesion: .5,
    maxModuleBoundaryRatio: .65,
})

const STARTER_BUDGETS = Object.freeze({
    runtimeCycles: PROVISIONAL_BUDGETS.runtimeCycles,
    maxFileLoc: PROVISIONAL_BUDGETS.maxFileLoc,
})

const BUDGET_PROPOSALS = Object.freeze(Object.entries(PROVISIONAL_BUDGETS)
    .filter(([key]) => !(key in STARTER_BUDGETS))
    .map(([key, value]) => ({
        key, value, state: 'CANDIDATE_NOT_ENFORCED',
        reason: 'Generic review threshold; adopt only after inspecting repository-specific evidence.',
    })))

const SOURCE_ROOTS = new Set(['src', 'app', 'lib', 'packages', 'services'])
const CODE_EXTENSIONS = new Set([
    '.cjs', '.cs', '.css', '.go', '.htm', '.html', '.java', '.js', '.jsx', '.less', '.mjs', '.py', '.pyi',
    '.rs', '.scss', '.ts', '.tsx',
])
const CLASSIFIED = ['test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp']
const EDGE_RELATIONS = new Set(['imports', 're_exports', 'calls', 'references'])

const slash = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
const extension = (file) => {
    const name = slash(file).split('/').at(-1) || ''
    const dot = name.lastIndexOf('.')
    return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}
const safeId = (value, fallback) => String(value || '').toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || fallback

function productFiles(graph, repoRoot) {
    const classifier = createPathClassifier(repoRoot)
    return [...new Set((graph?.nodes || [])
        .filter((node) => !String(node.id).includes('#'))
        .map((node) => slash(node.source_file || node.id))
        .filter((file) => file && CODE_EXTENSIONS.has(extension(file))))]
        .filter((file) => {
            const explanation = classifier.explain(file)
            return !explanation.excluded && !hasPathClass(explanation, ...CLASSIFIED)
        })
        .sort((a, b) => a.localeCompare(b))
}

function commonDirectoryPrefix(entries) {
    if (!entries.length) return []
    const first = entries[0].directories
    let length = first.length
    for (const entry of entries.slice(1)) {
        let index = 0
        while (index < length && index < entry.directories.length && first[index] === entry.directories[index]) index++
        length = index
    }
    // Keep at least one package segment available as an actual component territory.
    const shortest = Math.min(...entries.map((entry) => entry.directories.length))
    return first.slice(0, Math.min(length, Math.max(0, shortest - 1)))
}

function javaTerritories(files) {
    const byRoot = new Map()
    for (const file of files) {
        const match = /^(.*?)(?:\/)?src\/main\/java\/(.+\.java)$/i.exec(file)
        if (!match) continue
        const root = `${match[1] ? `${match[1]}/` : ''}src/main/java`
        const tail = match[2].split('/')
        const entry = {file, root, directories: tail.slice(0, -1)}
        const entries = byRoot.get(root) || []
        entries.push(entry)
        byRoot.set(root, entries)
    }
    const paths = new Map()
    for (const [root, entries] of byRoot) {
        const common = commonDirectoryPrefix(entries)
        for (const entry of entries) {
            const next = entry.directories[common.length]
            const path = next ? `${root}/${[...common, next].join('/')}` : entry.file
            paths.set(entry.file, {key: path, name: path, path})
        }
    }
    let refined = true
    while (refined) {
        refined = false
        const groups = new Map()
        for (const [file, territory] of paths) {
            const entries = groups.get(territory.key) || []
            entries.push({file, territory})
            groups.set(territory.key, entries)
        }
        for (const entries of groups.values()) {
            if (entries.length <= PROVISIONAL_BUDGETS.maxModuleFiles) continue
            const base = entries[0].territory.path
            if (!entries.every((entry) => entry.territory.path === base)) continue
            const nested = entries.map((entry) => ({...entry, rest: entry.file.slice(base.length + 1).split('/')}))
            const childDirectories = new Set(nested.filter((entry) => entry.rest.length > 1).map((entry) => entry.rest[0]))
            if (childDirectories.size < 2) continue
            for (const entry of nested) {
                if (entry.rest.length > 1) {
                    const path = `${base}/${entry.rest[0]}`
                    paths.set(entry.file, {key: path, name: path, path})
                } else {
                    paths.set(entry.file, {key: `${base}::root`, name: `${base} (root files)`, path: entry.file})
                }
            }
            refined = true
        }
    }
    return paths
}

function nestedSourceTerritory(file) {
    const match = /^(.*?)\/src\/(.+)$/.exec(file)
    if (!match || !match[1]) return null
    const tail = match[2].split('/')
    // Java's src/main/java package tree is handled with a package-aware common prefix above.
    if (tail[0] === 'main' && tail[1] === 'java') return null
    return tail.length > 1 ? `${match[1]}/src/${tail[0]}` : file
}

function genericTerritory(file) {
    const parts = file.split('/').filter(Boolean)
    if (parts.length === 1) return {key: 'root-code', name: 'root code', path: file}
    if (SOURCE_ROOTS.has(parts[0]) && parts.length === 2) {
        return {key: `${parts[0]}-root`, name: `${parts[0]} (root files)`, path: file}
    }
    const path = parts.slice(0, SOURCE_ROOTS.has(parts[0]) ? 2 : 1).join('/')
    return {key: path, name: path, path}
}

function componentsFor(graph, repoRoot) {
    const files = productFiles(graph, repoRoot)
    const java = javaTerritories(files)
    const groups = new Map()
    for (const file of files) {
        const adaptive = java.get(file) || nestedSourceTerritory(file)
        const territory = adaptive
            ? typeof adaptive === 'string' ? {key: adaptive, name: adaptive, path: adaptive} : adaptive
            : genericTerritory(file)
        const group = groups.get(territory.key) || {name: territory.name, paths: new Set(), files: 0}
        group.paths.add(territory.path)
        group.files++
        groups.set(territory.key, group)
    }
    return [...groups]
        .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
        .slice(0, 200)
        .map(([key, group], index) => ({
            id: safeId(key, `component-${index + 1}`),
            name: group.name,
            paths: [...group.paths].sort((a, b) => a.localeCompare(b)),
        }))
}

function componentFor(file, components) {
    const normalized = slash(file)
    let best = null
    for (const component of components) for (const prefix of component.paths) {
        if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) continue
        if (!best || prefix.length > best.prefix.length) best = {id: component.id, prefix}
    }
    return best?.id || null
}

const endpoint = (value) => value && typeof value === 'object' ? String(value.id) : String(value || '')
function fileOf(id, byId) {
    const node = byId.get(id)
    return slash(node?.source_file || id.split('#')[0])
}
function edgeKind(link) {
    return link.typeOnly === true ? 'type-only' : link.compileOnly === true ? 'compile-only' : 'runtime'
}

function observedDirections(graph, components) {
    const byId = new Map((graph?.nodes || []).map((node) => [String(node.id), node]))
    const pairs = new Set(), directions = new Map()
    for (const link of graph?.links || []) {
        if (!EDGE_RELATIONS.has(link.relation) || link.barrelProxy === true) continue
        const fromFile = fileOf(endpoint(link.source), byId), toFile = fileOf(endpoint(link.target), byId)
        const from = componentFor(fromFile, components), to = componentFor(toFile, components)
        if (!from || !to || from === to) continue
        const kind = edgeKind(link), pair = `${fromFile}\0${toFile}\0${kind}`
        if (pairs.has(pair)) continue
        pairs.add(pair)
        const key = `${from}\0${to}\0${kind}`
        const item = directions.get(key) || {from, to, kind, count: 0, samples: []}
        item.count++
        if (item.samples.length < 3) item.samples.push(`${fromFile} -> ${toFile}`)
        directions.set(key, item)
    }
    return [...directions.values()]
        .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
        .slice(0, 100)
        .map((item, index) => ({
            ...item,
            state: 'OBSERVED_NOT_ENFORCED',
            suggestedRule: {
                id: safeId(`observed-${item.from}-to-${item.to}-${item.kind}`, `observed-${index + 1}`),
                action: 'allow', kinds: [item.kind], from: [item.from], to: [item.to],
                reason: `Observed in ${item.count} unique file dependency pair(s); review before adopting as policy.`,
            },
        }))
}

export function proposeObservedDependencyDirections(graph, components) {
    return observedDirections(graph, components)
}

export function createArchitectureStarter(graph, repoRoot) {
    const components = componentsFor(graph, repoRoot)
    const contract = normalizeArchitectureContract({
        name: 'Proposed no-regressions baseline', style: 'custom', enforcement: 'ratchet', components,
        dependencyRules: [], budgets: STARTER_BUDGETS,
        technologies: {required: [], forbidden: []}, exceptions: [],
        ratchet: {baseline: {fingerprints: [], metrics: {}}},
    })
    return {
        contract,
        observedDependencyProposals: proposeObservedDependencyDirections(graph, contract.components),
        budgetProposals: BUDGET_PROPOSALS,
        methodology: 'adaptive product territories; only universal runtime-cycle/file-size guards are active; observed directions and generic quality thresholds are review-only',
    }
}
