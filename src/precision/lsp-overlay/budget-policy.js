import {boundedInteger} from '../../bounds.js'

const DEFAULT_MAX_SYMBOLS = 32
const BOUNDED_MAX_SYMBOLS = 64
const EXPANDED_MAX_SYMBOLS = 10_000
const DEFAULT_MAX_REFERENCES = 2_048
const BOUNDED_MAX_REFERENCES = 16_384
const EXPANDED_MAX_REFERENCES = 131_072
const DEFAULT_MAX_LINKS = 2_048
const BOUNDED_MAX_LINKS = 16_384
const EXPANDED_MAX_LINKS = 131_072
const DEFAULT_TIMEOUT_MS = 45_000
const BOUNDED_MAX_TIMEOUT_MS = 60_000
const EXPANDED_MAX_TIMEOUT_MS = 30 * 60_000

function configured(value, environmentName) {
  if (value !== undefined && value !== null && String(value).trim() !== '') return value
  const environmentValue = process.env[environmentName]
  return environmentValue != null && String(environmentValue).trim() !== ''
    ? environmentValue : undefined
}

export function precisionPrewarmBudget(options = {}) {
  const targetBatch = Array.isArray(options.targetIds) && options.targetIds.length > 0
  const configuredMode = String(configured(
    options.prewarmMode,
    'WEAVATRIX_PRECISION_PREWARM',
  ) || 'bounded').trim().toLowerCase()
  const full = configuredMode === 'full' && !targetBatch
  const requestedSymbols = configured(options.maxSymbols, 'WEAVATRIX_PRECISION_MAX_SYMBOLS')
  const numericSymbols = Number(requestedSymbols)
  const expanded = full || (Number.isFinite(numericSymbols) && numericSymbols > BOUNDED_MAX_SYMBOLS)
  const maxSymbols = full ? EXPANDED_MAX_SYMBOLS : boundedInteger(
    requestedSymbols,
    DEFAULT_MAX_SYMBOLS,
    1,
    expanded ? EXPANDED_MAX_SYMBOLS : BOUNDED_MAX_SYMBOLS,
  )
  const referenceFallback = expanded
    ? Math.min(EXPANDED_MAX_REFERENCES, Math.max(DEFAULT_MAX_REFERENCES, maxSymbols * 16))
    : DEFAULT_MAX_REFERENCES
  const linkFallback = expanded
    ? Math.min(EXPANDED_MAX_LINKS, Math.max(DEFAULT_MAX_LINKS, maxSymbols * 16))
    : DEFAULT_MAX_LINKS
  const timeoutFallback = expanded
    ? Math.min(15 * 60_000, Math.max(DEFAULT_TIMEOUT_MS, maxSymbols * 1_000))
    : DEFAULT_TIMEOUT_MS
  const maxReferences = boundedInteger(
    configured(options.maxReferences, 'WEAVATRIX_PRECISION_MAX_REFERENCES'),
    referenceFallback,
    1,
    expanded ? EXPANDED_MAX_REFERENCES : BOUNDED_MAX_REFERENCES,
  )
  const maxLinks = boundedInteger(
    configured(options.maxLinks, 'WEAVATRIX_PRECISION_MAX_LINKS'),
    linkFallback,
    1,
    expanded ? EXPANDED_MAX_LINKS : BOUNDED_MAX_LINKS,
  )
  const timeoutMs = boundedInteger(
    configured(options.timeoutMs, 'WEAVATRIX_PRECISION_TIMEOUT_MS'),
    timeoutFallback,
    100,
    expanded ? EXPANDED_MAX_TIMEOUT_MS : BOUNDED_MAX_TIMEOUT_MS,
  )
  return {
    expanded,
    full,
    maxSymbols,
    maxReferences,
    maxLinks,
    timeoutMs,
    maxOpenDocuments: expanded ? 1_024 : 96,
    maxOpenBytes: expanded ? 128 * 1024 * 1024 : 32 * 1024 * 1024,
    maxClassificationDocuments: expanded ? 1_024 : 96,
    maxClassificationBytes: expanded ? 128 * 1024 * 1024 : 32 * 1024 * 1024,
  }
}
