import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {retrieveTaskContext} from '../src/analysis/task-retrieval.js'

function graphFixture() {
  const nodes = [
    {id: 'src/auth/session.js#validateSession@10', label: 'validateSession()', source_file: 'src/auth/session.js', symbol_kind: 'function'},
    {id: 'src/http/router.js#registerRoutes@20', label: 'registerRoutes()', source_file: 'src/http/router.js', symbol_kind: 'function'},
    {id: 'src/cache/store.js#readCache@5', label: 'readCache()', source_file: 'src/cache/store.js', symbol_kind: 'function'},
    {id: 'src/auth/session.test.js#sessionTest@3', label: 'sessionTest()', source_file: 'src/auth/session.test.js', symbol_kind: 'function'},
  ]
  return {nodes, byId: new Map(nodes.map((node) => [node.id, node])), out: new Map(), inn: new Map()}
}

const CASES = [
  {task: 'validate authentication session', expected: 'src/auth/session.js#validateSession@10'},
  {task: 'register HTTP API routes', expected: 'src/http/router.js#registerRoutes@20'},
  {task: 'read values from cache store', expected: 'src/cache/store.js#readCache@5'},
]

function competitorTemplate(name) {
  return {name, status: 'MISSING', reason: 'supply same-task blind evaluator output with --independent-results <json>'}
}

function readCompetitors(path) {
  if (!path) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return parsed?.competitors && typeof parsed.competitors === 'object' ? parsed.competitors : {}
}

const SYSTEMS = ['weavatrix', 'codebase-memory', 'serena']
const median = (values) => {
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function independentComparison(path) {
  if (!path) return {status: 'MISSING', reason: 'supply blind evaluator output with --independent-results <json>'}
  try {
    const input = JSON.parse(readFileSync(path, 'utf8'))
    if (input?.schemaVersion !== 'weavatrix.agent-change-results.v1') throw new Error('unsupported schemaVersion')
    const taskSets = []
    const metrics = {}
    for (const name of SYSTEMS) {
      const runs = input.systems?.[name]?.runs
      if (!Array.isArray(runs) || !runs.length) throw new Error(`${name} has no runs`)
      const ids = runs.map((run) => String(run.taskId || '')).sort()
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error(`${name} task IDs are missing or duplicated`)
      for (const run of runs) {
        if (typeof run.success !== 'boolean' || !Number.isFinite(run.falsePositives) || !Number.isFinite(run.tokens) || !Number.isFinite(run.durationMs)) {
          throw new Error(`${name}/${run.taskId || '?'} has incomplete metrics`)
        }
      }
      taskSets.push(ids.join('\0'))
      metrics[name] = {
        tasks: runs.length, changeSuccessRate: runs.filter((run) => run.success).length / runs.length,
        falsePositiveRate: runs.reduce((sum, run) => sum + Math.max(0, run.falsePositives), 0) / runs.length,
        medianTokens: median(runs.map((run) => run.tokens)), medianDurationMs: median(runs.map((run) => run.durationMs)),
      }
    }
    if (new Set(taskSets).size !== 1) throw new Error('systems were not evaluated on the same task IDs')
    return {status: 'COMPLETE', evaluator: String(input.evaluator || 'unspecified'), metrics}
  } catch (error) {
    return {status: 'INVALID', reason: error instanceof Error ? error.message : String(error)}
  }
}

export function runAgentTaskBenchmark({competitorResults, independentResults} = {}) {
  const graph = graphFixture()
  const started = performance.now()
  const cases = CASES.map((item) => {
    const semanticSeeds = graph.nodes.filter((node) => item.task.toLowerCase().split(/\W+/).some((word) => word.length > 3 && String(node.id).toLowerCase().includes(word)))
    const result = retrieveTaskContext(graph, {task: item.task, semanticSeeds, maxSymbols: 2})
    const selected = result.selected.map((entry) => entry.id)
    return {task: item.task, expected: item.expected, selected, success: selected[0] === item.expected, falsePositives: selected.filter((id) => id !== item.expected).length}
  })
  const durationMs = performance.now() - started
  const output = JSON.stringify(cases)
  const imported = readCompetitors(competitorResults)
  const independent = independentComparison(independentResults)
  const competitors = independent.status === 'COMPLETE' ? {
    'codebase-memory': {name: 'codebase-memory', status: 'COMPLETE', metrics: independent.metrics['codebase-memory']},
    serena: {name: 'serena', status: 'COMPLETE', metrics: independent.metrics.serena},
  } : {
    'codebase-memory': imported['codebase-memory'] || competitorTemplate('codebase-memory'),
    serena: imported.serena || competitorTemplate('serena'),
  }
  return {
    schemaVersion: 'weavatrix.agent-task-benchmark.v1',
    scope: 'deterministic task-to-symbol routing microbenchmark; not an end-to-end autonomous change benchmark',
    weavatrix: {
      status: cases.every((item) => item.success) ? 'PASS' : 'FAIL', cases,
      metrics: {
        taskSuccessRate: cases.filter((item) => item.success).length / cases.length,
        falsePositiveRate: cases.reduce((sum, item) => sum + item.falsePositives, 0) / Math.max(1, cases.reduce((sum, item) => sum + item.selected.length, 0)),
        estimatedOutputTokens: Math.ceil(Buffer.byteLength(output) / 4), durationMs: Number(durationMs.toFixed(3)),
      },
    },
    competitors, independentComparison: independent,
    comparisonStatus: independent.status === 'COMPLETE' ? 'COMPLETE' : 'INCOMPLETE',
  }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runAgentTaskBenchmark({
    competitorResults: argument('--competitor-results'),
    independentResults: argument('--independent-results'),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if ((process.argv.includes('--require-independent') || process.argv.includes('--require-competitors')) && report.comparisonStatus !== 'COMPLETE') process.exitCode = 1
  if (report.weavatrix.status !== 'PASS') process.exitCode = 1
}
