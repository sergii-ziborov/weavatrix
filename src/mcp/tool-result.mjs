// MCP tool results keep a concise human summary and a stable machine-readable envelope together.
// Older clients continue to consume TextContent; MCP 2025-06 clients can use structuredContent
// directly without scraping prose. Tool implementations may opt into richer `result` data through
// toolResult(), while legacy string-returning tools still receive a deterministic envelope.

export const TOOL_RESULT_SCHEMA = 'weavatrix.tool.v1'

export function toolResult(text, result, extra = {}) {
    return {
        __weavatrixToolResult: true,
        text: String(text ?? ''),
        result: result && typeof result === 'object' ? result : {},
        warnings: Array.isArray(extra.warnings) ? extra.warnings : [],
        page: extra.page && typeof extra.page === 'object' ? extra.page : undefined,
        completeness: extra.completeness && typeof extra.completeness === 'object' ? extra.completeness : undefined,
    }
}

function repoName(repoRoot) {
    const parts = String(repoRoot || '').replace(/[\\/]+$/, '').split(/[\\/]/)
    const name = parts.pop() || 'unknown'
    return name.normalize('NFKC').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'unknown'
}

export function normalizeToolResult({toolName, value, args, ctx, refresh, warnings = [], freshness = 'unknown'}) {
    const rich = value && typeof value === 'object' && value.__weavatrixToolResult === true
    const text = rich ? value.text : String(value ?? '')
    const resultWarnings = [...(rich ? value.warnings : []), ...warnings]
    if (refresh?.notice) resultWarnings.unshift({code: 'GRAPH_AUTO_REFRESHED', message: refresh.notice})
    if (refresh?.error) resultWarnings.unshift({code: 'GRAPH_AUTO_REFRESH_FAILED', message: refresh.error})
    const structured = {
        schemaVersion: TOOL_RESULT_SCHEMA,
        tool: String(toolName || ''),
        repo: {name: repoName(ctx?.repoRoot)},
        graph: {
            revision: refresh?.revision || null,
            freshness: refresh?.error ? 'stale' : (refresh?.kind ? 'fresh' : freshness),
            update: refresh?.kind || 'none',
            changedFiles: Number(refresh?.changedFiles) || 0,
        },
        result: rich ? value.result : {text},
        evidence: [],
        warnings: resultWarnings,
        page: rich ? (value.page || {}) : {},
        ...(rich && value.completeness ? {completeness: value.completeness} : {}),
    }
    return {
        text: args?.output_format === 'json' ? JSON.stringify(structured, null, 2) : `Repository: ${structured.repo.name}\n${text}`,
        structured,
    }
}
