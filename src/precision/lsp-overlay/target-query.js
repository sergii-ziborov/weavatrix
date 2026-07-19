import {isStructuralRelation} from '../../graph/relations.js'
import {JS_TS_FILE, endpoint, norm} from './contract.js'
import {
  ensureBudget,
  ensureFullUniverse,
  ensureOpen,
  requestReferences,
} from './source-session.js'

function supportFilesFor(session, target, relPath) {
  const supportFiles = []
  for (const link of session.graph.links || []) {
    if (endpoint(link.target) !== String(target.id) || isStructuralRelation(link.relation)) continue
    const sourceId = endpoint(link.source)
    const sourceFile = norm(session.nodesById.get(sourceId)?.source_file
      || (sourceId.includes('#') ? sourceId.slice(0, sourceId.indexOf('#')) : sourceId))
    if (sourceFile && JS_TS_FILE.test(sourceFile)
      && sourceFile !== relPath && !supportFiles.includes(sourceFile)) supportFiles.push(sourceFile)
    if (supportFiles.length >= 12) break
  }
  return supportFiles
}

export async function queryPrecisionTarget(session, target) {
  const relPath = norm(target.source_file)
  await ensureOpen(session, relPath)
  for (const file of supportFilesFor(session, target, relPath)) await ensureOpen(session, file)
  if (session.universe.complete
    && session.universe.files.every((file) => session.opened.has(file))) {
    session.fullUniverseOpened = true
  }
  let locations = await requestReferences(session, relPath, target.selection_start)
  if (!Array.isArray(locations)) throw new Error('language server returned an invalid references result')
  session.queried++
  if (locations.length !== 0) return locations
  ensureBudget(session)
  const configRel = session.semanticInputs.fileConfigs?.[relPath]
  const project = configRel ? session.semanticInputs.projects?.[configRel] : null
  const configuredFiles = [...new Set((project?.projectFiles || [])
    .map(norm).filter((file) => JS_TS_FILE.test(file)))].sort()
  const projectFiles = new Set(configuredFiles)
  const exactlyCoversUniverse = session.universe.complete
    && configuredFiles.length === session.universe.files.length
    && session.universe.files.every((file) => projectFiles.has(file))
  ensureBudget(session)
  if (configRel && projectFiles.has(relPath) && exactlyCoversUniverse) {
    const alreadyComplete = session.fullUniverseOpened
    if (alreadyComplete || await ensureFullUniverse(session)) {
      if (!alreadyComplete) locations = await requestReferences(session, relPath, target.selection_start)
      if (!Array.isArray(locations)) throw new Error('language server returned an invalid references result')
      if (locations.length === 0) session.noReferenceSymbols.push(String(target.id))
    }
  }
  return locations
}
