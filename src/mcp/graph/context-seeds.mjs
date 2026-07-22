import {PATH_CLASS_NAMES, PATH_CLASS_QUERY_TERMS, createPathClassifier, hasPathClass} from '../../path-classification.js'
import {degreeOf, isSymbol, uniqueConnCount} from './context-core.mjs'

const QUERY_STOP = new Set('a an and are around architecture best code do does exact explain find focus focused for from how identify in inspect inspection is logic me of or path production project repository request requests rest show symbol symbols the through to trace what where which with'.split(' '))
const QUERY_INTENTS = [
    ['bootstrap', ['bootstrap', 'startup', 'entrypoint', 'entry', 'main', 'root', 'app', 'application', 'applications', 'index', 'server', 'cli']],
    ['tool-execution', ['tool', 'tools', 'tooling', 'mcp', 'execution', 'execute', 'invocation', 'invoke', 'dispatch', 'dispatcher', 'handler', 'catalog', 'registry']],
    ['auth', ['auth', 'authentication', 'authorization', 'login', 'session', 'authgate']],
    ['routing', ['routing', 'router', 'routes', 'route', 'navigation']],
    ['layout', ['layout', 'layouts', 'shell']],
    ['api', ['api', 'apis', 'endpoint', 'endpoints', 'client']],
    ['state', ['state', 'store', 'stores', 'reducer', 'context']],
]
const INTENT_BY_TERM = new Map(QUERY_INTENTS.filter(([id]) => id !== 'tool-execution')
    .flatMap(([id, terms]) => terms.map((term) => [term, {id, terms}])))
const TOOL_EXECUTION_TERMS = QUERY_INTENTS.find(([id]) => id === 'tool-execution')[1]
const TOOL_EXECUTION_TRIGGERS = new Set(['tool', 'tools', 'tooling', 'mcp'])
const wordsOf = (value) => String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
const normPath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|java|rs|kt|kts|cs|rb|php|sol|sql)$/i
const DATA_OR_PROSE_RE = /\.(?:json|ya?ml|toml|ini|md|mdx|rst|adoc|html?|css|scss|less|svg)$/i
const LANGUAGE_EXTENSIONS = Object.freeze({
    rust: ['rs'], python: ['py', 'pyi'], typescript: ['ts', 'tsx', 'mts', 'cts'],
    javascript: ['js', 'jsx', 'mjs', 'cjs'], go: ['go'], java: ['java'], csharp: ['cs'],
    solidity: ['sol'], sql: ['sql'],
})

function requestedLanguages(query) {
    const raw = String(query || ''), words = new Set(wordsOf(query)), requested = new Set()
    if (words.has('rust')) requested.add('rust')
    if (words.has('python') || words.has('py')) requested.add('python')
    if (words.has('typescript') || words.has('ts') || /typescript/i.test(raw)) requested.add('typescript')
    if (words.has('javascript') || words.has('js') || words.has('nodejs') || /javascript|node\.?js/i.test(raw)) requested.add('javascript')
    if (words.has('golang') || /(?:^|[^A-Za-z])Go(?:[^A-Za-z]|$)/.test(raw)) requested.add('go')
    if (words.has('java')) requested.add('java')
    if (words.has('csharp') || words.has('dotnet') || /csharp|(?:^|[^A-Za-z])C#(?:[^A-Za-z]|$)/i.test(raw)) requested.add('csharp')
    if (words.has('solidity') || words.has('contract') || words.has('contracts')) requested.add('solidity')
    if (words.has('sql') || words.has('schema') || words.has('migration') || words.has('migrations')) requested.add('sql')
    return new Set([...requested].flatMap((language) => LANGUAGE_EXTENSIONS[language]))
}

const sourceFileOf = (node) => normPath(node?.source_file || String(node?.id ?? '').split('#', 1)[0])
const matchesLanguage = (node, extensions) => {
    if (!extensions.size) return true
    const match = /\.([^.\/]+)$/.exec(sourceFileOf(node))
    return !!match && extensions.has(match[1].toLowerCase())
}

export function requestedPathClasses(query) {
    const words = new Set(wordsOf(query)), requested = new Set()
    for (const [category, terms] of Object.entries(PATH_CLASS_QUERY_TERMS)) if (terms.some((term) => words.has(term))) requested.add(category)
    if (requested.has('test')) requested.add('e2e')
    if (requested.has('e2e')) requested.add('test')
    return requested
}

function isQueryEligible(node, requestedClasses, classificationCache, classifier) {
    if (node?.test_surface === true && !requestedClasses.has('test')) return false
    const source = sourceFileOf(node)
    if (!source) return true
    if (!classificationCache.has(source)) classificationCache.set(source, classifier.explain(source, {content: ''}))
    const info = classificationCache.get(source)
    const classified = PATH_CLASS_NAMES.filter((category) => hasPathClass(info, category))
    return classified.length === 0 || classified.some((category) => requestedClasses.has(category))
}

function entrypointSignal(g, node, source, stem) {
    if (isSymbol(node.id) || !CODE_FILE_RE.test(source)) return 0
    const depth = source.split('/').length
    let score = 0
    if (node.entrypoint === true || node.is_entrypoint === true || node.declared_entry === true) score = 72
    if (/^bin\//.test(source) || /\/(?:bin|cmd)\//.test(source)) score = Math.max(score, 62)
    if (depth <= 2 && /^(?:index|main|app|server|cli|bootstrap|entry|run)$/.test(stem)) score = Math.max(score, 60)
    if (depth <= 2 && /(?:^|[-_.])(?:main|server|cli|bootstrap|entry)(?:$|[-_.])/.test(stem)) score = Math.max(score, 57)
    if (depth <= 3 && /^(?:main|app|server|cli|bootstrap|entry|run)$/.test(stem)) score = Math.max(score, 52)
    const incoming = uniqueConnCount(g.inn.get(String(node.id))), outgoing = uniqueConnCount(g.out.get(String(node.id)))
    if (score && incoming === 0 && outgoing > 0) score += Math.min(7, 2 + outgoing)
    return score
}

function toolExecutionSignal(node, source, words, stem) {
    if (!CODE_FILE_RE.test(source)) return 0
    let score = 0
    if (/(^|\/)(?:mcp(?:[-_.][^/]*)?|tools?)(?:\/|[-_.])/.test(source)) score = Math.max(score, 51)
    if (/^(?:catalog|dispatch(?:er)?|registry)$/.test(stem)) score = Math.max(score, 68)
    if (/^(?:tool[-_.]?(?:handler|runner|executor)|tools?[-_.])/.test(stem)) score = Math.max(score, 55)
    if ([...words].some((word) => /^(?:dispatch|dispatcher|toolcall|toolhandler|executetool|invoketool|calltool)$/.test(word))) score = Math.max(score, 64)
    if (source.includes('/mcp/') || stem.includes('mcp-server')) score = Math.max(score, 48)
    return score
}

// relaxStop is the last-resort fallback: when EVERY token is a stop word (e.g. a bare
// "architecture" query), keep them as concepts so the query still seeds instead of
// misreporting "No nodes matched" for a concept the repository clearly contains.
function queryConcepts(query, {relaxStop = false} = {}) {
    const tokens = wordsOf(query)
    const toolExecution = tokens.some((token) => TOOL_EXECUTION_TRIGGERS.has(token))
    const explanatoryWork = tokens.some((token) => token === 'how' || token === 'explain')
    const seen = new Set(), concepts = []
    for (const raw of tokens) {
        if (raw.length < 2 || (!relaxStop && QUERY_STOP.has(raw))) continue
        if (explanatoryWork && (raw === 'work' || raw === 'works' || raw === 'working')) continue
        if (toolExecution && TOOL_EXECUTION_TERMS.includes(raw)) {
            if (seen.has('tool-execution')) continue
            const trigger = tokens.find((token) => TOOL_EXECUTION_TRIGGERS.has(token)) || raw
            seen.add('tool-execution')
            concepts.push({id: 'tool-execution', raw: trigger, terms: [trigger, ...TOOL_EXECUTION_TERMS.filter((term) => term !== trigger)]})
            continue
        }
        const intent = INTENT_BY_TERM.get(raw), id = intent?.id || raw
        if (seen.has(id)) continue
        seen.add(id)
        concepts.push({id, raw, terms: intent ? [raw, ...intent.terms.filter((term) => term !== raw)] : [raw]})
    }
    return concepts
}

function exactIdentifierSeeds(g, query, limit, {repoRoot = null} = {}) {
    const identifiers = [...new Set((String(query || '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [])
        .filter((item) => /(?:[a-z0-9][A-Z]|_)/.test(item)).map((item) => item.toLowerCase()))]
    if (!identifiers.length) return []
    const requestedClasses = requestedPathClasses(query), languageExtensions = effectiveLanguages(g, query)
    const classifier = createPathClassifier(repoRoot), classificationCache = new Map(), matches = []
    for (const identifier of identifiers) {
        const candidates = g.nodes.filter((node) => String(node.label || '').replace(/\(\)$/, '').toLowerCase() === identifier
            && matchesLanguage(node, languageExtensions) && isQueryEligible(node, requestedClasses, classificationCache, classifier))
            .sort((left, right) => degreeOf(g, right.id) - degreeOf(g, left.id) || String(left.id).localeCompare(String(right.id)))
        for (const node of candidates) {
            if (!matches.some((existing) => String(existing.id) === String(node.id))) matches.push(node)
            if (matches.length >= limit) return matches
        }
    }
    return matches
}

function conceptScore(g, node, concept, queryContext) {
    const id = normPath(node.id), label = String(node.label ?? '').toLowerCase(), source = sourceFileOf(node)
    const stem = (label.split('/').pop() || '').replace(/\.[^.]+$/, '')
    const words = new Set(wordsOf(`${node.id} ${node.label ?? ''} ${node.source_file ?? ''}`))
    const segments = new Set(source.split('/').flatMap((part) => wordsOf(part.replace(/\.[^.]+$/, ''))))
    let match = 0
    concept.terms.forEach((term, index) => {
        const primary = index === 0
        if (label === term || stem === term) match = Math.max(match, primary ? 60 : 42)
        else if (segments.has(term)) match = Math.max(match, primary ? 48 : 36)
        else if (words.has(term)) match = Math.max(match, primary ? 36 : 25)
        else if (term.length >= 4 && term !== 'tool' && term !== 'tools' && (id.includes(term) || label.includes(term))) match = Math.max(match, primary ? 12 : 7)
    })
    const extension = (/\.([^.\/]+)$/.exec(source) || [])[1] || ''
    const languageConcept = {rust: ['rs'], python: ['py', 'pyi'], py: ['py', 'pyi'], typescript: ['ts', 'tsx', 'mts', 'cts'], ts: ['ts', 'tsx', 'mts', 'cts'], javascript: ['js', 'jsx', 'mjs', 'cjs'], js: ['js', 'jsx', 'mjs', 'cjs'], nodejs: ['js', 'jsx', 'mjs', 'cjs'], golang: ['go'], go: ['go'], java: ['java'], csharp: ['cs'], dotnet: ['cs'], solidity: ['sol'], sql: ['sql'], schema: ['sql']}[concept.raw]
    if (languageConcept?.includes(extension) && queryContext.languageExtensions.has(extension)) match = Math.max(match, 58)
    const fileNode = !isSymbol(node.id), depth = source ? source.split('/').length : 9
    if (concept.id === 'bootstrap') match = Math.max(match, entrypointSignal(g, node, source, stem))
    if (concept.id === 'tool-execution') match = Math.max(match, toolExecutionSignal(node, source, words, stem))
    if (!match) return 0
    let score = match + (fileNode ? 7 : 0) + Math.max(0, 4 - depth) + Math.min(2, degreeOf(g, node.id) / 40)
    if ((concept.id === 'bootstrap' || concept.id === 'tool-execution') && DATA_OR_PROSE_RE.test(source)) score -= 34
    if ((concept.id === 'bootstrap' || concept.id === 'tool-execution') && !fileNode) score -= 18
    if (queryContext.runtimeIntent && !queryContext.maintenanceIntent && /^(?:scripts?|tools?\/scripts?)\//.test(source)) score -= 32
    if (queryContext.runtimeIntent && /^(?:site|website|public|static|assets)\//.test(source)) score -= 28
    return Math.max(0, score)
}

// A requested language that matches ZERO nodes in this graph is over-eager inference (e.g.
// "contract" inferring Solidity in a repo with no .sol files); drop the filter rather than
// eliminate every candidate and return nothing.
function effectiveLanguages(g, query) {
    const languageExtensions = requestedLanguages(query)
    if (languageExtensions.size && !g.nodes.some((node) => matchesLanguage(node, languageExtensions))) return new Set()
    return languageExtensions
}

export function findSeeds(g, query, limit = 8, {repoRoot = null} = {}) {
    const exact = exactIdentifierSeeds(g, query, limit, {repoRoot})
    if (exact.length) return exact
    let concepts = queryConcepts(query)
    if (!concepts.length) concepts = queryConcepts(query, {relaxStop: true})
    if (!concepts.length || limit <= 0) return []
    const requestedClasses = requestedPathClasses(query), languageExtensions = effectiveLanguages(g, query)
    const queryContext = {runtimeIntent: concepts.some((concept) => concept.id === 'bootstrap' || concept.id === 'tool-execution'), maintenanceIntent: wordsOf(query).some((word) => ['script', 'scripts', 'build', 'release', 'publish', 'packaging'].includes(word)), languageExtensions}
    const classifier = createPathClassifier(repoRoot), classificationCache = new Map()
    const rows = g.nodes.filter((node) => matchesLanguage(node, languageExtensions) && isQueryEligible(node, requestedClasses, classificationCache, classifier)).map((node) => {
        const scores = concepts.map((concept) => conceptScore(g, node, concept, queryContext))
        return {node, scores, total: Math.max(...scores) + scores.reduce((sum, score) => sum + score, 0) / 10}
    })
    const chosen = [], used = new Set()
    for (let index = 0; index < concepts.length && chosen.length < limit; index++) {
        const best = rows.filter((row) => !used.has(String(row.node.id)) && row.scores[index] > 0)
            .sort((a, b) => b.scores[index] - a.scores[index] || String(a.node.id).localeCompare(String(b.node.id)))[0]
        if (best) { chosen.push(best.node); used.add(String(best.node.id)) }
    }
    rows.filter((row) => row.total > 0 && !used.has(String(row.node.id)))
        .sort((a, b) => b.total - a.total || String(a.node.id).localeCompare(String(b.node.id)))
        .slice(0, Math.max(0, limit - chosen.length)).forEach((row) => chosen.push(row.node))
    return chosen
}

export function resolveSeedFiles(g, requested, limit = 12) {
    const files = Array.isArray(requested) ? requested.slice(0, limit) : [], seeds = [], missing = []
    for (const raw of files) {
        const wanted = normPath(raw)
        const node = g.nodes.find((candidate) => !isSymbol(candidate.id) && (normPath(candidate.id) === wanted || normPath(candidate.source_file) === wanted))
        if (!node) missing.push(String(raw))
        else if (!seeds.some((seed) => String(seed.id) === String(node.id))) seeds.push(node)
    }
    return {seeds, missing}
}
