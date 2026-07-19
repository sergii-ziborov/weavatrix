import {classifyTypeScriptReferenceUsage} from '../typescript-lsp-provider.js'
import {endpoint, norm} from './contract.js'
import {locationStart, repoFileFromLocation, sourceAt} from './target-index.js'
import {remaining, sourceForClassification} from './source-session.js'

function moduleDependencyAt(session, source, file, targetFile, exactLine) {
  if (source !== file || !targetFile) return null
  return (session.graph.links || []).find((link) => endpoint(link.source) === file
    && endpoint(link.target) === targetFile
    && ['imports', 're_exports'].includes(String(link.relation || ''))
    && Number.isInteger(link.line) && link.line === exactLine)
}

function addUnknownEvidence(session, source, targetId, line, character) {
  const key = `${source}\0${targetId}\0${line}\0${character}`
  if (session.evidenceSeen.has(key)) return true
  if (session.referenceEvidence.length >= session.boundedLinks) {
    session.truncated = true
    session.stop = true
    return false
  }
  session.evidenceSeen.add(key)
  session.unclassifiedReferences++
  session.referenceEvidence.push({
    source,
    target: targetId,
    line,
    character,
    classification: 'unknown',
    provider: 'typescript-language-server',
  })
  return true
}

function addExactLink(session, targetId, source, location, line, character, usage, moduleDependency) {
  const relation = 'references'
  const key = `${source}\0${relation}\0${targetId}\0${line}\0${character}`
  if (session.seen.has(key)) return true
  if (session.links.length >= session.boundedLinks) {
    session.truncated = true
    session.stop = true
    return false
  }
  session.seen.add(key)
  session.links.push({
    source,
    target: targetId,
    relation,
    line,
    character,
    ...(Number.isInteger(location?.range?.end?.line) ? {endLine: location.range.end.line + 1} : {}),
    ...(Number.isInteger(location?.range?.end?.character) ? {endCharacter: location.range.end.character} : {}),
    provenance: 'EXACT_LSP',
    provider: 'typescript-language-server',
    ...(usage === 'type' || moduleDependency?.typeOnly === true ? {typeOnly: true} : {}),
    ...(usage === 'compile' || moduleDependency?.compileOnly === true ? {compileOnly: true} : {}),
  })
  return true
}

export function collectReferenceResults(session, target, locations) {
  for (const location of locations) {
    if (remaining(session) <= 0 || session.references >= session.boundedReferences) {
      session.truncated = true
      session.stop = true
      break
    }
    session.references++
    const file = repoFileFromLocation(session.repoRoot, location)
    const start = locationStart(location)
    if (!file || !start || !Number.isInteger(start.line) || !Number.isInteger(start.character)) continue
    const source = sourceAt(session.index, file, start)
    const targetId = String(target.id)
    const exactLine = start.line + 1
    const character = start.character
    const targetFile = norm(target.source_file)
    const moduleDependency = moduleDependencyAt(
      session, source, file, targetFile, exactLine,
    )
    const sourceText = sourceForClassification(session, file)
    let usage = sourceText == null
      ? 'unknown'
      : classifyTypeScriptReferenceUsage(file, sourceText, start)
    if (usage === 'unknown' && moduleDependency?.typeOnly === true) usage = 'type'
    if (usage === 'unknown' && moduleDependency?.compileOnly === true) usage = 'compile'
    if (session.collectLocations) session.exactLocations.push({
      file,
      source: source || file,
      target: targetId,
      line: exactLine,
      character,
      ...(Number.isInteger(location?.range?.end?.line) ? {endLine: location.range.end.line + 1} : {}),
      ...(Number.isInteger(location?.range?.end?.character) ? {endCharacter: location.range.end.character} : {}),
      classification: usage,
    })
    if (!source || source === targetId) {
      if (usage === 'unknown') session.unclassifiedReferences++
      continue
    }
    if (usage === 'unknown') {
      if (!addUnknownEvidence(session, source, targetId, exactLine, character)) break
      continue
    }
    if (!addExactLink(
      session, targetId, source, location, exactLine, character, usage, moduleDependency,
    )) break
  }
}
