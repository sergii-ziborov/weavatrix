import {findSeeds, rawGraph} from './graph-context.mjs'
import {toolResult} from './tool-result.mjs'
import {expandTaskQuery, retrieveTaskContext} from '../analysis/task-retrieval.js'
import {extractCallArgumentEvidence} from '../analysis/data-flow-evidence.js'
import {runAllowedTests, validateTestRequests} from '../analysis/allowed-test-runner.js'
import {compareDuplicateGroups} from '../analysis/duplicate-groups.js'
import {buildGraphAtGitRef} from '../analysis/git-ref-graph.js'
import {diffGraphs, formatGraphDiff} from './graph-diff.mjs'

const richResult = (value) => value?.__weavatrixToolResult === true ? value.result : null
const normalizeFile = (value) => String(value || '').replace(/\\/g, '/')
const changedFilesOf = (impact) => [...new Set((impact?.changes || []).flatMap((change) => [change.path, change.oldPath, change.newPath]).map(normalizeFile).filter((file) => file && file !== '(diff unavailable)'))]
const targetTests = (impact) => [...new Set([
  ...(impact?.testEvidence?.changedFiles || []).map((item) => item.staticTestReachability?.test),
  ...(impact?.blastRadius?.nodes || []).map((node) => node.testEvidence?.staticTestReachability?.test),
].filter(Boolean))].slice(0, 30)

function testCoverage(proof, requests, suggested) {
  if (!suggested.length) return {state: 'NOT_APPLICABLE', covered: [], missing: []}
  if (proof.state !== 'PASS') return {state: 'PENDING', covered: [], missing: suggested}
  if ((requests || []).some((request) => request?.script === 'test' && (!request.args || !request.args.length))) {
    return {state: 'COMPLETE', kind: 'full-test-script', covered: suggested, missing: []}
  }
  const args = (requests || []).flatMap((request) => request?.args || []).map(normalizeFile)
  const covered = suggested.filter((file) => args.some((arg) => arg === file || arg.endsWith(`/${file}`)))
  return {state: covered.length === suggested.length ? 'COMPLETE' : 'PARTIAL', kind: 'explicit-test-paths', covered, missing: suggested.filter((file) => !covered.includes(file))}
}

function graphProof(diff) {
  const runtimeCycles = diff?.cycles?.runtime?.introduced || []
  return {
    state: runtimeCycles.length ? 'BLOCKED' : diff.schemaMigration ? 'UNKNOWN' : 'PASS',
    ...(diff.schemaMigration ? {reason: 'graph extractor/schema versions differ, so structural ratchets are not comparable'} : {}),
    summary: formatGraphDiff(diff),
    counts: {
      nodesAdded: diff.nodes.added.length, nodesRemoved: diff.nodes.removed.length,
      edgesAdded: diff.edges.added, edgesRemoved: diff.edges.removed,
      moduleDependenciesAdded: diff.moduleEdges.added.length, orphaned: diff.orphaned.length,
      runtimeCyclesIntroduced: runtimeCycles.length,
    },
    runtimeCycles: runtimeCycles.slice(0, 20), moduleDependenciesAdded: diff.moduleEdges.added.slice(0, 20),
    orphaned: diff.orphaned.slice(0, 20), schemaMigration: diff.schemaMigration,
  }
}

async function baselineProof(ctx, baseRef, currentGraph) {
  const mode = ['full', 'no-tests', 'tests-only'].includes(currentGraph?.graphBuildMode) ? currentGraph.graphBuildMode : 'full'
  const built = await buildGraphAtGitRef(ctx.repoRoot, baseRef, {mode})
  if (!built.ok) return {state: 'UNKNOWN', reason: built.error}
  return {...graphProof(diffGraphs(built.graph, currentGraph)), baseline: {ref: built.ref, commit: built.commit}}
}

function apiState(result) {
  if (!result || result.status !== 'COMPLETE' || result.completeness?.complete !== true) return 'UNKNOWN'
  if (['HTTP_METHOD_MISMATCH', 'CLIENTS_AT_RISK_WITH_METHOD_MISMATCHES'].includes(result.verdict?.code)) return 'BLOCKED'
  return 'UNKNOWN'
}

function architectureState(result) {
  if (!result || result.state === 'NOT_CONFIGURED' || result.state === 'ERROR') return 'UNKNOWN'
  if (!result.verification) return result.state === 'READY' ? 'PASS' : 'UNKNOWN'
  return result.verification.new?.length || String(result.verification.status).toUpperCase() === 'FAIL' ? 'BLOCKED' : 'PASS'
}

function exactUsageLines(contexts, g) {
  if (!contexts.length) return []
  return contexts.map((context) => {
    const node = g.byId.get(String(context.symbol || context.definition?.id || ''))
    const label = String(context.definition?.label || node?.label || context.symbol || 'symbol')
    if (context.status !== 'OK') return `Exact usage: ${label} — unavailable (${context.status || 'UNKNOWN'}).`
    const exact = context.evidence?.state === 'EXACT'
    const occurrences = Number(context.references?.occurrences) || 0
    const files = Number(context.references?.files) || 0
    const inbound = Array.isArray(context.inbound?.shown) ? context.inbound.shown.slice(0, 3) : []
    const callers = inbound.map((item) => `${item.label || item.id}${item.file ? ` [${item.file}]` : ''}`).join(', ')
    return `${exact ? 'Exact usage' : 'Bounded usage'}: ${label} — ${occurrences} reference occurrence(s)${files ? ` in ${files} file(s)` : ''}; ${Number(context.inbound?.total) || 0} inbound container(s)${callers ? `: ${callers}` : ''}.`
  })
}

function decide({phase, impact, graph, architecture, duplicates, api, tests, suggestedTests, testCoverageState}) {
  if (phase === 'plan') return tests.state === 'BLOCKED'
    ? {verdict: 'BLOCKED', blockers: [`targeted test plan was rejected: ${tests.reason || 'invalid request'}`], unknowns: []}
    : {verdict: 'UNKNOWN', blockers: [], unknowns: ['verification has not run; apply the edit and call verified_change with phase=verify']}
  if (impact.status === 'COMPLETE' && !impact.changes?.length) return {verdict: 'PASS', blockers: [], unknowns: []}
  const blockers = [], unknowns = []
  if (impact.status !== 'COMPLETE') unknowns.push('change impact is partial or has unmapped evidence')
  if (graph.state === 'BLOCKED') blockers.push('the change introduces a runtime dependency cycle')
  if (graph.state === 'UNKNOWN') unknowns.push(`Git graph baseline is unavailable: ${graph.reason || 'unknown reason'}`)
  if (architecture.state === 'BLOCKED') blockers.push('new architecture-contract violations were found')
  if (architecture.state === 'UNKNOWN') unknowns.push('architecture contract is not configured or verification is incomplete')
  if (duplicates.state === 'BLOCKED') blockers.push('new duplicate groups intersect the changed files')
  if (duplicates.state === 'UNKNOWN') unknowns.push(`duplicate ratchet is incomplete: ${duplicates.reason || 'health capability unavailable'}`)
  if (api.state === 'BLOCKED') blockers.push('cross-repository API evidence contains HTTP method mismatches')
  if (api.state === 'UNKNOWN') unknowns.push(`API contract evidence is incomplete: ${api.reason || 'no bounded proof'}`)
  if (tests.state === 'FAIL' || tests.state === 'BLOCKED') {
    const failed = (tests.results || []).filter((result) => result.status !== 'PASS').map((result) => `${result.script} (${result.status}${result.exitCode == null ? '' : `, exit ${result.exitCode}`})`)
    blockers.push(`targeted tests failed or were rejected: ${tests.reason || failed.join(', ') || 'unknown failure'}`)
  }
  if (tests.state === 'DISABLED') unknowns.push('targeted test execution was requested but runtime permission is disabled')
  if (tests.state === 'NOT_REQUESTED' && suggestedTests.length) unknowns.push('affected tests were identified but no allowlisted package test was requested')
  if (tests.state === 'PASS' && testCoverageState.state === 'PARTIAL') unknowns.push(`targeted test run did not cover ${testCoverageState.missing.length} suggested test path(s)`)
  return {verdict: blockers.length ? 'BLOCKED' : unknowns.length ? 'UNKNOWN' : 'PASS', blockers, unknowns}
}

export async function tVerifiedChange(g, args = {}, ctx = {}, tools = {}, permissions = {}) {
  const phase = args.phase === 'verify' ? 'verify' : 'plan'
  const currentGraph = rawGraph(ctx)
  const impactValue = await tools.impact(g, {base: args.base_ref, diff: args.diff, files: args.files, depth: args.impact_depth, max_nodes: args.max_impact_nodes}, ctx)
  const impact = richResult(impactValue) || {status: 'PARTIAL', changes: [], seeds: {ids: []}, blastRadius: {nodes: []}}
  const changedFiles = changedFilesOf(impact)
  const retrieval = retrieveTaskContext(g, {
    task: args.task, semanticSeeds: findSeeds(g, expandTaskQuery(args.task), 12, {repoRoot: ctx.repoRoot}),
    changedSeedIds: impact.seeds?.ids, maxSymbols: args.max_symbols, repoRoot: ctx.repoRoot,
  })

  let contexts = []
  if (permissions.source) contexts = await Promise.all(retrieval.selected.map(async (symbol) => {
    const value = await tools.context(g, {label: symbol.id, precision: args.precision, max_related: 8, max_source_files: 3, context_lines: 4}, ctx, tools.inspect)
    const result = richResult(value)
    return result ? {symbol: symbol.id, status: result.status, definition: result.definition, evidence: result.evidence, references: result.references, inbound: result.inbound, outbound: result.outbound, reExports: result.reExports, source: result.source} : {symbol: symbol.id, status: 'UNKNOWN'}
  }))
  const dataFlow = permissions.source ? extractCallArgumentEvidence({
      graph: g, repoRoot: ctx.repoRoot, seedIds: retrieval.selected.map((item) => item.id),
      depth: Math.max(1, Math.min(3, Number(args.data_flow_depth) || 2)),
      maxEdges: Math.max(1, Math.min(60, Number(args.max_data_flow_edges) || 30)),
    })
    : {model: 'bounded call-argument-to-parameter evidence (not CFG or taint analysis)', status: 'UNAVAILABLE', reason: 'source capability is not enabled', edges: [], unsupportedEdges: 0, capped: false}
  const suggestedTests = targetTests(impact)
  const checkedTests = validateTestRequests(ctx.repoRoot, args.tests || [])
  const testProof = phase === 'verify'
    ? await runAllowedTests(ctx.repoRoot, args.tests || [], {enabled: args.run_tests === true, timeoutMs: args.test_timeout_ms})
    : {state: checkedTests.ok ? 'PLANNED' : 'BLOCKED', reason: checkedTests.reason, plan: checkedTests.tests || [], results: []}
  const testCoverageState = testCoverage(testProof, args.tests || [], suggestedTests)

  const architectureValue = phase === 'verify'
    ? (permissions.health ? tools.verifyArchitecture(g, {}, ctx) : null)
    : tools.prepareChange(g, {intent: args.task, files: changedFiles}, ctx)
  const architectureResult = richResult(architectureValue)
  const architecture = {state: architectureState(architectureResult), evidence: architectureResult}
  const baseRef = String(args.base_ref || 'HEAD').trim()
  const graph = phase === 'verify' ? await baselineProof(ctx, baseRef, currentGraph) : {state: 'PLANNED', baseline: baseRef}

  let duplicates = {state: 'SKIPPED', reason: 'duplicate ratchet disabled'}
  if (phase === 'verify' && args.duplicate_ratchet !== false) duplicates = permissions.health
    ? await compareDuplicateGroups({repoRoot: ctx.repoRoot, graphPath: ctx.graphPath, currentGraph, baseRef, changedFiles, args: {mode: 'renamed', min_similarity: 80, min_tokens: 50}})
    : {state: 'UNKNOWN', reason: 'health capability is not enabled'}

  let api = {state: 'SKIPPED', reason: 'no api_contract scope was requested'}
  if (args.api_contract) {
    if (!permissions.crossrepo) api = {state: 'UNKNOWN', reason: 'crossrepo capability is not enabled'}
    else {
      const result = richResult(await tools.traceApi(g, {
        ...args.api_contract, changed_files: args.api_contract.changed_files || changedFiles,
        max_endpoints: Math.min(100, Number(args.api_contract.max_endpoints) || 100),
        max_matches: Math.min(500, Number(args.api_contract.max_matches) || 500),
        max_affected_files: Math.min(100, Number(args.api_contract.max_affected_files) || 100),
        top_n: Math.min(10, Number(args.api_contract.top_n) || 10),
      }, ctx))
      api = {state: apiState(result), evidence: result}
    }
  }

  const decision = decide({phase, impact, graph, architecture, duplicates, api, tests: testProof, suggestedTests, testCoverageState})
  if (!permissions.source && retrieval.selected.length) decision.unknowns.push('source capability is disabled; exact LSP/source edit contexts were not collected')
  if (phase === 'verify' && contexts.some((item) => item.status !== 'OK' || item.evidence?.state !== 'EXACT' || item.references?.capped)) {
    decision.unknowns.push('one or more exact edit contexts are incomplete')
  }
  if (phase === 'verify' && args.diff) decision.unknowns.push('a supplied diff was classified, but equivalence between that patch and the active graph is not proven; verify on a checked-out change without diff')
  if (decision.verdict === 'PASS' && decision.unknowns.length) decision.verdict = 'UNKNOWN'
  const result = {
    schemaVersion: 'weavatrix.verified-change.v1', verdict: decision.verdict, phase, task: String(args.task),
    blockers: decision.blockers, unknowns: decision.unknowns,
    retrieval, editContexts: contexts, dataFlow, changeImpact: impact, graphBaseline: graph,
    architecture, duplicates, apiContract: api, tests: {...testProof, suggestedFiles: suggestedTests, coverage: testCoverageState},
  }
  const text = [
    `${decision.verdict} — verified_change ${phase}`, `Task: ${String(args.task).slice(0, 500)}`,
    `Change: ${changedFiles.length} file(s), ${impact.seeds?.ids?.length || 0} exact seed(s), blast radius ${impact.blastRadius?.impacted || 0}.`,
    `Edit context: ${retrieval.selected.length} symbol(s); ${contexts.length} exact bundle(s); data-flow ${dataFlow.status} (${dataFlow.edges.length} call edge(s)).`,
    ...exactUsageLines(contexts, g),
    `Ratchets: graph ${graph.state}; architecture ${architecture.state}; duplicates ${duplicates.state}; API ${api.state}; tests ${testProof.state}.`,
    ...decision.blockers.map((item) => `BLOCKER: ${item}`), ...decision.unknowns.map((item) => `UNKNOWN: ${item}`),
  ].join('\n')
  return toolResult(text, result, {completeness: {status: decision.verdict === 'UNKNOWN' ? 'PARTIAL' : 'COMPLETE'}})
}
