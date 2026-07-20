// Text mode stays genuinely compact for agents and older clients: it returns TextContent only.
// JSON mode adds the stable machine-readable structuredContent envelope and mirrors that envelope
// into TextContent for workflow runners that cannot consume structured results directly.

const TOOL_RESULT_SCHEMA = 'weavatrix.tool.v1'

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
    const json = args?.output_format === 'json'
    return {
        text: json ? JSON.stringify(structured, null, 2) : `Repository: ${structured.repo.name}\n${text}`,
        // MCP output schemas apply to every invocation of a tool. The catalog intentionally does not
        // advertise one because text mode must not attach a second, potentially very large payload.
        // JSON callers still receive the stable structured result as an optional MCP extension.
        structured: json ? structured : undefined,
    }
}
