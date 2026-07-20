import {createHash} from 'node:crypto'
import {readFileSync, statSync} from 'node:fs'
import {createRepoBoundary} from '../../repo-path.js'
import {norm} from './contract.js'
import {
  PrecisionBudgetError,
  PrecisionLimitError,
  PrecisionStaleGraphError,
} from './semantic-inputs.js'

export function initializeSourceSession(session) {
  session.boundary = createRepoBoundary(session.repoRoot)
  session.opened = new Set()
  session.openedTexts = new Map()
  session.classificationTexts = new Map()
  session.classificationBytes = 0
  session.openedBytes = 0
  session.fullUniverseOpened = false
}

export const remaining = (session) => session.deadline - Date.now()

export function ensureBudget(session) {
  if (remaining(session) <= 0) throw new PrecisionBudgetError()
}

export function awaitWithBudget(session, operation) {
  ensureBudget(session)
  const wait = remaining(session)
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new PrecisionBudgetError()), wait)
    Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); rejectPromise(error) },
    )
  })
}

function verifiedSource(session, relPath, maxBytes = 4 * 1024 * 1024) {
  const file = norm(relPath)
  const expectedHash = session.graph.fileHashes?.[file]
  if (!file || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) {
    throw new PrecisionStaleGraphError()
  }
  const resolvedFile = session.boundary.resolve(file)
  if (!resolvedFile.ok) throw new PrecisionStaleGraphError()
  let size
  try { size = statSync(resolvedFile.path).size }
  catch { throw new PrecisionStaleGraphError() }
  if (size > maxBytes) throw new PrecisionLimitError('precision source-read budget reached')
  let body
  try { body = readFileSync(resolvedFile.path) }
  catch { throw new PrecisionStaleGraphError() }
  if (body.byteLength > maxBytes) throw new PrecisionLimitError('precision source-read budget reached')
  if (createHash('sha256').update(body).digest('hex') !== expectedHash) {
    throw new PrecisionStaleGraphError()
  }
  return {file, body, bytes: body.byteLength, text: body.toString('utf8')}
}

export async function ensureOpen(session, relPath) {
  const file = norm(relPath)
  if (!file || session.opened.has(file)) return
  ensureBudget(session)
  const maxDocuments = Number(session.maxOpenDocuments) || 96
  const maxOpenBytes = Number(session.maxOpenBytes) || 32 * 1024 * 1024
  if (session.opened.size >= maxDocuments) {
    throw new PrecisionLimitError('precision open-document limit reached')
  }
  const maxBytes = Math.min(4 * 1024 * 1024, maxOpenBytes - session.openedBytes)
  const {bytes, text} = verifiedSource(session, file, maxBytes)
  if (bytes > 4 * 1024 * 1024) throw new PrecisionLimitError('precision document exceeds 4 MiB limit')
  if (session.openedBytes + bytes > maxOpenBytes) {
    throw new PrecisionLimitError('precision source-transfer budget reached')
  }
  await awaitWithBudget(session, () => session.client.openDocument(file, text))
  session.opened.add(file)
  session.openedTexts.set(file, text)
  session.openedBytes += bytes
}

export function sourceForClassification(session, relPath) {
  const file = norm(relPath)
  if (session.openedTexts.has(file)) return session.openedTexts.get(file)
  if (session.classificationTexts.has(file)) return session.classificationTexts.get(file)
  const maxDocuments = Number(session.maxClassificationDocuments) || 96
  const maxClassificationBytes = Number(session.maxClassificationBytes) || 32 * 1024 * 1024
  if (session.classificationTexts.size >= maxDocuments) return null
  let source
  try {
    source = verifiedSource(
      session,
      file,
      Math.min(4 * 1024 * 1024, maxClassificationBytes - session.classificationBytes),
    )
  } catch (error) {
    if (error instanceof PrecisionLimitError) return null
    throw error
  }
  session.classificationTexts.set(file, source.text)
  session.classificationBytes += source.bytes
  return source.text
}

export async function ensureFullUniverse(session) {
  if (session.fullUniverseOpened) return true
  if (!session.universe.complete) return false
  const additional = session.universe.files.filter((file) => !session.opened.has(file))
  const maxDocuments = Number(session.maxOpenDocuments) || 96
  const maxOpenBytes = Number(session.maxOpenBytes) || 32 * 1024 * 1024
  if (session.opened.size + additional.length > maxDocuments) {
    session.truncated = true
    return false
  }
  let projectedBytes = session.openedBytes
  for (const file of additional) {
    ensureBudget(session)
    if (!/^[a-f0-9]{64}$/i.test(String(session.graph.fileHashes?.[file] || ''))) {
      throw new PrecisionStaleGraphError()
    }
    const resolvedFile = session.boundary.resolve(file)
    if (!resolvedFile.ok) throw new PrecisionStaleGraphError()
    let bytes
    try { bytes = statSync(resolvedFile.path).size }
    catch { throw new PrecisionStaleGraphError() }
    if (bytes > 4 * 1024 * 1024 || projectedBytes + bytes > maxOpenBytes) {
      session.truncated = true
      return false
    }
    projectedBytes += bytes
  }
  for (const file of additional) await ensureOpen(session, file)
  session.fullUniverseOpened = session.universe.files.every((file) => session.opened.has(file))
  return session.fullUniverseOpened
}

export function requestReferences(session, relPath, position) {
  return awaitWithBudget(
    session,
    () => session.client.references(relPath, position, false, Math.max(1, remaining(session))),
  )
}
