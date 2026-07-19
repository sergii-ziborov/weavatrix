import {boundedInteger} from '../../bounds.js'
import {createTypeScriptLspClient} from '../typescript-lsp-provider.js'
import {baseOverlay} from './contract.js'
import {precisionOverlayMatches} from './contract.js'
import {collectReferenceResults} from './reference-results.js'
import {
  PrecisionBudgetError,
  PrecisionLimitError,
  PrecisionStaleGraphError,
  PrecisionStaleSemanticInputsError,
  graphJavaScriptUniverse,
  precisionSemanticInputs,
  publicSemanticSafetyReason,
} from './semantic-inputs.js'
import {
  awaitWithBudget,
  ensureBudget,
  initializeSourceSession,
  remaining,
} from './source-session.js'
import {readPrecisionOverlay, writePrecisionOverlay} from './store.js'
import {eligibleTargets, symbolIndex} from './target-index.js'
import {queryPrecisionTarget} from './target-query.js'

function persist(session, overlay) {
  return session.graphPath ? writePrecisionOverlay(session.graphPath, overlay) : overlay
}

function coverage(session, verifiedEdges = session.links.length) {
  return {
    candidates: session.eligible.total,
    selected: session.targets.length,
    queried: session.queried,
    references: session.references,
    unclassifiedReferences: session.unclassifiedReferences,
    verifiedEdges,
    truncated: session.truncated,
  }
}

function completedOverlay(session) {
  const state = session.errors || session.truncated || session.unclassifiedReferences
    ? 'PARTIAL' : 'COMPLETE'
  return baseOverlay(session.graph, state, {
    request: session.request,
    engines: [{
      provider: session.client.provider || 'typescript-language-server',
      version: session.client.version || null,
      typescriptVersion: session.client.typescriptVersion || null,
      typescriptSource: session.client.typescriptSource || null,
      language: 'typescript/javascript',
      capability: 'textDocument/references',
      status: state,
      configuredPluginsSuppressed: session.semanticInputs.pluginsSuppressed || 0,
      repoLocalPluginLoads: false,
    }],
    semanticInputFingerprint: session.semanticInputs.fingerprint,
    pluginPolicy: {
      configuredPluginsSuppressed: session.semanticInputs.pluginsSuppressed || 0,
      repoLocalPluginLoads: false,
    },
    coverage: coverage(session),
    links: session.links,
    referenceEvidence: session.referenceEvidence,
    ...(session.collectLocations ? {locations: session.exactLocations} : {}),
    noReferenceSymbols: session.noReferenceSymbols,
    ...(session.errors ? {reason: `${session.errors} semantic request(s) failed or were refused`}
      : session.truncated ? {reason: 'semantic precision stopped at a configured safety limit'}
        : session.unclassifiedReferences
          ? {reason: 'some exact references could not be classified as runtime or type-only'} : {}),
  })
}

function failedOverlay(session, error) {
  const stale = error instanceof PrecisionStaleGraphError
  const semanticInputsChanged = error instanceof PrecisionStaleSemanticInputsError
  const deadlineReached = error instanceof PrecisionBudgetError || remaining(session) <= 0
  const state = stale || semanticInputsChanged || deadlineReached ? 'PARTIAL' : 'UNAVAILABLE'
  return baseOverlay(session.graph, state, {
    request: session.request,
    reason: stale
      ? 'repository content no longer matched the graph snapshot'
      : semanticInputsChanged ? 'TypeScript project inputs changed while semantic precision was running'
        : deadlineReached ? 'semantic precision stopped at its global deadline'
          : error?.name === 'LspTimeoutError' ? 'bundled TypeScript language server timed out'
            : 'bundled TypeScript language server was unavailable',
    engines: [{
      provider: 'typescript-language-server',
      version: null,
      language: 'typescript/javascript',
      capability: 'textDocument/references',
      status: state,
    }],
    coverage: {
      candidates: session.eligible.total,
      selected: session.targets.length,
      queried: stale || semanticInputsChanged ? 0 : session.queried,
      references: stale || semanticInputsChanged ? 0 : session.references,
      unclassifiedReferences: stale || semanticInputsChanged ? 0 : session.unclassifiedReferences,
      verifiedEdges: 0,
      truncated: session.truncated || stale || semanticInputsChanged || deadlineReached,
    },
    links: [],
    noReferenceSymbols: [],
  })
}

function createSession(options) {
  const boundedMax = boundedInteger(options.maxSymbols, 32, 1, 64)
  const boundedReferences = boundedInteger(options.maxReferences, 2_048, 1, 16_384)
  const boundedLinks = boundedInteger(options.maxLinks, 2_048, 1, 16_384)
  const boundedTimeout = boundedInteger(options.timeoutMs, 45_000, 100, 60_000)
  return {
    ...options,
    boundedMax,
    boundedReferences,
    boundedLinks,
    deadline: Date.now() + boundedTimeout,
    request: {maxSymbols: boundedMax, maxReferences: boundedReferences, maxLinks: boundedLinks},
    links: [],
    seen: new Set(),
    evidenceSeen: new Set(),
    queried: 0,
    references: 0,
    unclassifiedReferences: 0,
    errors: 0,
    truncated: false,
    noReferenceSymbols: [],
    referenceEvidence: [],
    exactLocations: [],
    collectLocations: Array.isArray(options.targetIds) && options.targetIds.length > 0,
    stop: false,
  }
}

export async function buildLspPrecisionOverlay({
  repoRoot,
  graph,
  graphPath,
  mode = 'lsp',
  maxSymbols = Number(process.env.WEAVATRIX_PRECISION_MAX_SYMBOLS) || 32,
  maxReferences = Number(process.env.WEAVATRIX_PRECISION_MAX_REFERENCES) || 2_048,
  maxLinks = Number(process.env.WEAVATRIX_PRECISION_MAX_LINKS) || 2_048,
  timeoutMs = Number(process.env.WEAVATRIX_PRECISION_TIMEOUT_MS) || 45_000,
  targetIds,
  clientFactory,
} = {}) {
  if (!graph || !repoRoot) throw new Error('precision overlay requires repoRoot and graph')
  const session = createSession({
    repoRoot, graph, graphPath, mode, maxSymbols, maxReferences, maxLinks,
    timeoutMs, targetIds, clientFactory,
  })
  if (mode === 'off') {
    return persist(session, baseOverlay(graph, 'OFF', {
      request: session.request,
      reason: 'precision disabled by request',
    }))
  }
  session.universe = graphJavaScriptUniverse(graph)
  if (!session.universe.files.length) {
    return persist(session, baseOverlay(graph, 'UNAVAILABLE', {
      request: session.request,
      reason: 'semantic precision currently supports JavaScript and TypeScript repositories',
    }))
  }
  session.semanticInputs = precisionSemanticInputs(repoRoot, graph, {deadline: session.deadline})
  if (!session.semanticInputs.safe) {
    return persist(session, baseOverlay(graph, 'UNAVAILABLE', {
      request: session.request,
      reason: publicSemanticSafetyReason(session.semanticInputs.reason),
      engines: [{
        provider: 'typescript-language-server', version: null,
        language: 'typescript/javascript', capability: 'textDocument/references',
        status: 'UNAVAILABLE',
      }],
    }))
  }
  if (graphPath) {
    const cached = readPrecisionOverlay(graphPath, graph)
    if (cached?.state === 'COMPLETE'
      && precisionOverlayMatches(cached, graph, {request: session.request})
      && cached.semanticInputFingerprint === session.semanticInputs.fingerprint) return cached
  }
  session.eligible = eligibleTargets(graph, session.boundedMax, targetIds)
  session.targets = session.eligible.targets
  if (!session.targets.length) {
    return persist(session, baseOverlay(graph, 'COMPLETE', {
      request: session.request,
      semanticInputFingerprint: session.semanticInputs.fingerprint,
      pluginPolicy: {
        configuredPluginsSuppressed: session.semanticInputs.pluginsSuppressed || 0,
        repoLocalPluginLoads: false,
      },
      reason: 'no eligible JavaScript/TypeScript semantic targets',
    }))
  }
  session.truncated = session.eligible.total > session.boundedMax
  session.index = symbolIndex(graph)
  session.nodesById = new Map((graph.nodes || []).map((node) => [String(node.id), node]))
  initializeSourceSession(session)
  try {
    const makeClient = clientFactory || createTypeScriptLspClient
    session.client = await awaitWithBudget(
      session,
      () => makeClient({repoRoot, timeoutMs: Math.max(100, remaining(session))}),
    )
    for (const target of session.targets) {
      let locations
      try {
        locations = await queryPrecisionTarget(session, target)
      } catch (error) {
        if (error instanceof PrecisionStaleGraphError) throw error
        if (error instanceof PrecisionBudgetError || error instanceof PrecisionLimitError
          || remaining(session) <= 0) {
          session.truncated = true
          session.stop = true
          break
        }
        session.errors++
        continue
      }
      collectReferenceResults(session, target, locations)
      if (remaining(session) <= 0) {
        session.truncated = true
        session.stop = true
      }
      if (session.stop) break
    }
    ensureBudget(session)
    const semanticInputsAfter = precisionSemanticInputs(repoRoot, graph, {deadline: session.deadline})
    ensureBudget(session)
    if (!semanticInputsAfter.safe
      || semanticInputsAfter.fingerprint !== session.semanticInputs.fingerprint) {
      throw new PrecisionStaleSemanticInputsError()
    }
    return persist(session, completedOverlay(session))
  } catch (error) {
    return persist(session, failedOverlay(session, error))
  } finally {
    if (session.client) {
      const closeBudget = Math.min(2_000, Math.max(0, remaining(session)))
      if (closeBudget > 0 && session.client.close) {
        try { await awaitWithBudget(session, () => session.client.close(closeBudget)) }
        catch { session.client.kill?.() }
      } else session.client.kill?.()
    }
  }
}
