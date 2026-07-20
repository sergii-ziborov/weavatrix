import {PATH_CLASS_NAMES, PATH_CLASS_TASK_QUERY_TERMS, createPathClassifier, hasPathClass} from '../path-classification.js'

const words = (value) => new Set(String(value || '').toLowerCase().match(/[\p{L}_$][\p{L}\p{N}_$-]{2,}/gu) || [])
const fileOf = (node) => String(node?.source_file || (String(node?.id || '').includes('#') ? String(node.id).split('#')[0] : node?.id || '')).replace(/\\/g, '/')
const isSymbol = (id) => String(id || '').includes('#')

const INTENT_TRANSLATIONS = [
  [/авториз|аутентиф|логин|сесси|токен/iu, 'auth authentication login session token'],
  [/маршрут|роут|эндпоинт|апи|http/iu, 'route router endpoint api http'],
  [/тест|покрыти/iu, 'test spec coverage verify'],
  [/к[эе]ш|хранилищ/iu, 'cache store storage'],
  [/баз[аы]|запрос|sql/iu, 'database query sql'],
  [/конфиг|настройк/iu, 'config settings configuration'],
  [/безопас|вредонос|секрет/iu, 'security malware secret'],
  [/зависим|импорт/iu, 'dependency import module'],
  [/дублик|клон/iu, 'duplicate clone'],
]

export function expandTaskQuery(task) {
  const text = String(task || '')
  const expansions = INTENT_TRANSLATIONS.filter(([pattern]) => pattern.test(text)).map(([, value]) => value)
  return [...new Set([text, ...expansions])].join(' ')
}

function overlapScore(taskWords, node) {
  const haystack = words(`${node?.label || ''} ${node?.id || ''} ${node?.symbol_kind || ''}`)
  let score = 0
  for (const word of taskWords) if (haystack.has(word)) score += 8
  return score
}

function addCandidate(map, node, score, reason) {
  if (!node?.id) return
  const id = String(node.id)
  const current = map.get(id) || {node, score: 0, reasons: new Set()}
  current.score += score
  current.reasons.add(reason)
  map.set(id, current)
}

function containedSymbols(g, node) {
  if (isSymbol(node?.id)) return [node]
  return (g.out.get(String(node?.id)) || [])
    .filter((edge) => edge.relation === 'contains')
    .map((edge) => g.byId.get(String(edge.id)))
    .filter(Boolean)
}

// Combines intent-expanded search seeds with exact changed symbols. The result deliberately stays
// deterministic and source-free; exact LSP/source evidence is collected by context_bundle later.
export function retrieveTaskContext(g, {
  task, semanticSeeds = [], changedSeedIds = [], maxSymbols = 3, repoRoot = null, includeClassified = false,
} = {}) {
  const expandedTask = expandTaskQuery(task)
  const taskWords = words(expandedTask)
  const requestedClasses = new Set(Object.entries(PATH_CLASS_TASK_QUERY_TERMS)
    .filter(([, terms]) => terms.some((term) => taskWords.has(term)))
    .map(([name]) => name))
  if (requestedClasses.has('test')) requestedClasses.add('e2e')
  if (requestedClasses.has('e2e')) requestedClasses.add('test')
  const classifier = createPathClassifier(repoRoot)
  const classificationCache = new Map()
  const changedFiles = new Set((changedSeedIds || []).map((id) => fileOf(g.byId.get(String(id)) || {id})))
  const pathAllowed = (node) => {
    const file = fileOf(node)
    if (!file || changedFiles.has(file) || includeClassified === true) return true
    // Node-level test surfaces (Rust #[cfg(test)]) follow the same production-first policy.
    if (node?.test_surface === true && !requestedClasses.has('test')) return false
    if (!classificationCache.has(file)) classificationCache.set(file, classifier.explain(file, {content: ''}))
    const info = classificationCache.get(file)
    const classes = PATH_CLASS_NAMES.filter((name) => hasPathClass(info, name))
    if (!info?.excluded && !classes.length) return true
    return classes.some((name) => requestedClasses.has(name))
  }
  const candidates = new Map()
  for (const id of changedSeedIds || []) {
    const node = g.byId.get(String(id))
    if (node) addCandidate(candidates, node, 100 + overlapScore(taskWords, node), 'changed-symbol')
  }
  for (const seed of semanticSeeds || []) addCandidate(candidates, seed, 45 + overlapScore(taskWords, seed), 'task-intent')

  for (const candidate of [...candidates.values()]) {
    for (const symbol of containedSymbols(g, candidate.node)) {
      const degree = (g.out.get(String(symbol.id)) || []).length + (g.inn.get(String(symbol.id)) || []).length
      addCandidate(candidates, symbol, 22 + overlapScore(taskWords, symbol) + Math.min(12, degree), `symbol-in:${fileOf(candidate.node)}`)
    }
  }

  const symbolCandidates = [...candidates.values()].filter((item) => isSymbol(item.node.id))
  const ranked = symbolCandidates
    .filter((item) => pathAllowed(item.node))
    .sort((left, right) => right.score - left.score || String(left.node.id).localeCompare(String(right.node.id)))
  const limit = Math.max(1, Math.min(5, Number(maxSymbols) || 3))
  return {
    method: 'intent-expanded graph retrieval + exact changed-symbol seeds',
    status: ranked.length ? 'COMPLETE' : 'NO_SYMBOLS',
    selected: ranked.slice(0, limit).map((item) => ({
      id: String(item.node.id), label: item.node.label || String(item.node.id), file: fileOf(item.node),
      kind: item.node.symbol_kind || null, score: item.score, reasons: [...item.reasons].sort(),
    })),
    candidateCount: ranked.length,
    suppressedClassified: symbolCandidates.length - ranked.length,
    pathPolicy: includeClassified === true
      ? {mode: 'ALL_CLASSIFIED'}
      : {mode: 'PRODUCTION_FIRST', requestedClasses: [...requestedClasses].sort(), changedFilesPinned: changedFiles.size},
  }
}
