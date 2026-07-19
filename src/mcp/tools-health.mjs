// Propagate catalog.mjs's cache-busting query to owner modules so development hot reload remains
// behaviorally identical to the former single-file implementation.
const version = new URL(import.meta.url).search
const load = (path) => import(new URL(`${path}${version}`, import.meta.url).href)
const [duplicates, deadCode, auditFormat, audit, structure, endpoints] = await Promise.all([
  load('./health/duplicates.mjs'),
  load('./health/dead-code.mjs'),
  load('./health/audit-format.mjs'),
  load('./health/audit.mjs'),
  load('./health/structure.mjs'),
  load('./health/endpoints.mjs'),
])

export const tFindDuplicates = duplicates.tFindDuplicates
export const tFindDeadCode = deadCode.tFindDeadCode
export const auditFindingPathScope = auditFormat.auditFindingPathScope
export const formatAuditFinding = auditFormat.formatAuditFinding
export const isDependencyAuditFinding = auditFormat.isDependencyAuditFinding
export const tRunAudit = audit.tRunAudit
export const tCoverageMap = structure.tCoverageMap
export const tHotPathReview = structure.tHotPathReview
export const tListCommunities = structure.tListCommunities
export const tModuleMap = structure.tModuleMap
export const tListEndpoints = endpoints.tListEndpoints
