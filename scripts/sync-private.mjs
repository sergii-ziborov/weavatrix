import {existsSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {runtime} from './mcp-runtime-smoke.mjs'

const root = resolve(process.argv.slice(2).find((arg) => arg !== '--confirm') || process.cwd())
const confirmed = process.argv.includes('--confirm')
const endpoint = process.env.WEAVATRIX_SYNC_URL
const token = process.env.WEAVATRIX_SYNC_TOKEN
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

if (!existsSync(root)) throw new Error(`Repository does not exist: ${root}`)
if (!endpoint || !token) throw new Error('WEAVATRIX_SYNC_URL and WEAVATRIX_SYNC_TOKEN are required')
if (!confirmed) throw new Error('No graph was sent. Review the destination, then rerun with --confirm')

const server = runtime(
    join(packageRoot, 'bin', 'weavatrix-mcp.mjs'),
    root,
    'full',
    process.env.WEAVATRIX_GRAPH_HOME || join(homedir(), '.weavatrix'),
    {WEAVATRIX_PRECISION: 'lsp'},
)

const call = async (name, args, timeoutMs = 120_000) => {
    const response = await server.request('tools/call', {name, arguments: args}, timeoutMs)
    const text = (response?.content || []).map((item) => item?.text || '').join('\n')
    if (response?.isError) throw new Error(text || `${name} failed`)
    return {response, text}
}

try {
    await server.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: {name: 'weavatrix-private-release-sync', version: '1.0.0'},
    })
    const rebuilt = await call('rebuild_graph', {mode: 'full', precision: 'lsp', output_format: 'json'})
    const preview = await call('preview_sync', {payload_version: 3, output_format: 'json'})
    const approved = preview.response?.structuredContent?.result
    if (approved?.status !== 'PREVIEW_READY' || !approved.confirmToken) {
        throw new Error(`preview_sync did not return an approval token: ${preview.text}`)
    }
    console.log(`Approved ${approved.destination}; ${approved.nodes} nodes / ${approved.links} edges; SHA-256 ${String(approved.bodyHash).slice(0, 12)}`)
    const sent = await call('sync_graph', {
        dry_run: false, confirm_token: approved.confirmToken, timeout_ms: 60_000,
    })
    if (!/pushed to approved destination/i.test(sent.text)) throw new Error(sent.text)
    console.log(sent.text.replace(/^Repository:[^\n]*\n/, ''))
    const state = rebuilt.response?.structuredContent?.result || {}
    console.log(`Semantic precision: ${state.precision?.state || state.semanticPrecision?.state || 'reported in graph'}; private sync complete.`)
} finally {
    await server.stop()
}
