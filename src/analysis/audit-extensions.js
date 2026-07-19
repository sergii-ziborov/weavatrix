import {sortFindings, summarizeFindings} from './findings.js'

const VALID_STATUS = new Set(['CHECKED', 'NOT_CHECKED', 'PARTIAL', 'ERROR', 'NOT_SUPPORTED'])
const VALID_COMPLETENESS = new Set(['COMPLETE', 'PARTIAL'])

const providerFailure = (provider, reason) => ({
    id: provider.id,
    extension: provider.extension || null,
    status: 'ERROR',
    completeness: 'PARTIAL',
    detail: reason,
    findings: [],
})

const normalizeResult = (provider, value) => {
    if (!value || typeof value !== 'object') return providerFailure(provider, 'provider returned no result envelope')
    const status = VALID_STATUS.has(value.status) ? value.status : 'ERROR'
    const completeness = VALID_COMPLETENESS.has(value.completeness) ? value.completeness : 'PARTIAL'
    const findings = Array.isArray(value.findings) ? value.findings.map((finding) => ({
        ...finding,
        source: finding?.source || `extension:${provider.extension || provider.id}`,
    })) : []
    return {
        id: provider.id,
        extension: provider.extension || null,
        status,
        completeness,
        detail: String(value.detail || (status === 'ERROR' ? 'provider returned an invalid status' : 'extension analyzer completed')),
        findings,
        evidence: value.evidence ?? null,
    }
}

// Extension analyzers are deliberately local. A provider failure stays explicit ERROR/PARTIAL and
// never converts missing evidence into a clean result for the core audit.
export async function applyAuditExtensions(coreAudit, {providers = [], repoRoot, graph, args = {}} = {}) {
    if (!coreAudit?.ok || !providers.length) return coreAudit
    const results = []
    for (const provider of providers) {
        try {
            const value = await provider.run({repoRoot, graph, args, coreAudit})
            results.push(normalizeResult(provider, value))
        } catch (error) {
            results.push(providerFailure(provider, error instanceof Error ? error.message : String(error)))
        }
    }
    const findings = sortFindings([
        ...coreAudit.findings,
        ...results.flatMap((result) => result.findings),
    ])
    return {
        ...coreAudit,
        findings,
        summary: summarizeFindings(findings),
        extensionCapabilities: results.map(({findings: providerFindings, ...result}) => ({
            ...result,
            findingCount: providerFindings.length,
        })),
    }
}
