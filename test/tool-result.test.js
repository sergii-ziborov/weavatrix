import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeToolResult, toolResult} from '../src/mcp/tool-result.mjs'

test('structured tool result mirrors valid JSON and preserves warnings', () => {
  const value = toolResult('human', {status: 'PASS'})
  const normalized = normalizeToolResult({
    toolName: 'verify_architecture', value, args: {output_format: 'json'},
    ctx: {repoRoot: 'C:/work/example'}, freshness: 'stale',
    warnings: [{code: 'GRAPH_STALE', message: 'stale'}],
  })
  assert.deepEqual(JSON.parse(normalized.text), normalized.structured)
  assert.equal(normalized.structured.graph.freshness, 'stale')
  assert.equal(normalized.structured.result.status, 'PASS')
  assert.equal(normalized.structured.warnings[0].code, 'GRAPH_STALE')
})
