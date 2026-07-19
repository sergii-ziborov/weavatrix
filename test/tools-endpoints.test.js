import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadGraph} from '../src/mcp/graph-context.mjs'
import {tTraceEndpoint} from '../src/mcp/tools-endpoints.mjs'

test('trace_endpoint binds a composed route to a bounded multi-hop call graph', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-endpoint-trace-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'services', 'attack'), {recursive: true})
        writeFileSync(join(repo, 'app.js'), "import attack from './services/attack/router.js'\napp.use('/warRoom/attack', attack)\n")
        writeFileSync(join(repo, 'services', 'attack', 'router.js'), "router.post('/:attackId/startMitigate', controller.startMitigate)\n")
        writeFileSync(join(repo, 'services', 'attack', 'controller.js'), [
            'export async function startMitigate(req) {',
            '  const id = req.params.attackId',
            '  return attackService.startMitigate(id)',
            '}',
        ].join('\n'))
        writeFileSync(join(repo, 'services', 'attack', 'service.js'), [
            'export async function startMitigate(id) {',
            '  validate(id)',
            '  return taskQueue.enqueue(id)',
            '}',
        ].join('\n'))
        writeFileSync(join(repo, 'services', 'attack', 'task.js'), 'export function enqueue(id) { return id }\n')
        const files = ['app.js', 'services/attack/router.js', 'services/attack/controller.js', 'services/attack/service.js', 'services/attack/task.js']
        const nodes = files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'}))
        nodes.push(
            {id: 'services/attack/controller.js#startMitigate@1', label: 'startMitigate()', source_file: 'services/attack/controller.js', source_location: 'L1', file_type: 'code'},
            {id: 'services/attack/service.js#startMitigate@1', label: 'startMitigate()', source_file: 'services/attack/service.js', source_location: 'L1', file_type: 'code'},
            {id: 'services/attack/task.js#enqueue@1', label: 'enqueue()', source_file: 'services/attack/task.js', source_location: 'L1', file_type: 'code'},
        )
        writeFileSync(graphPath, JSON.stringify({
            repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, nodes,
            links: [
                {source: 'services/attack/controller.js#startMitigate@1', target: 'services/attack/service.js#startMitigate@1', relation: 'calls', line: 3, provenance: 'EXTRACTED'},
                {source: 'services/attack/service.js#startMitigate@1', target: 'services/attack/task.js#enqueue@1', relation: 'calls', line: 3, provenance: 'EXTRACTED'},
            ],
        }))
        const result = tTraceEndpoint(loadGraph(graphPath), {path: '/warRoom/attack/:attackId/startMitigate', method: 'POST'}, {repoRoot: repo})
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.endpoint.declaredPath, '/:attackId/startMitigate')
        assert.equal(result.result.endpoint.path, '/warRoom/attack/:attackId/startMitigate')
        assert.equal(result.result.trace.edges.length, 2)
        assert.match(result.text, /controller\.js:3/)
        assert.match(result.text, /taskQueue\.enqueue/)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('trace_endpoint exposes a Spring route that is inactive by default', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-spring-endpoint-trace-'))
    const graphPath = join(repo, 'graph.json')
    const file = 'src/main/java/com/acme/StatusController.java'
    try {
        mkdirSync(join(repo, 'src', 'main', 'java', 'com', 'acme'), {recursive: true})
        writeFileSync(join(repo, file), [
            '@RestController',
            '@ConditionalOnExpression("${status.controller:false}")',
            '@RequestMapping("/status")',
            'class StatusController {',
            '  @GetMapping("/ready")',
            '  public String ready() { return "ok"; }',
            '}',
        ].join('\n'))
        writeFileSync(graphPath, JSON.stringify({
            repoBoundaryV: 1,
            edgeTypesV: 2,
            edgeProvenanceV: 1,
            nodes: [
                {id: file, label: file, source_file: file, file_type: 'code'},
                {id: `${file}#ready@6`, label: 'ready()', source_file: file, source_location: 'L6', file_type: 'code'},
            ],
            links: [],
        }))

        const result = tTraceEndpoint(loadGraph(graphPath), {path: '/status/ready', method: 'GET'}, {repoRoot: repo})
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.endpoint.conditional, true)
        assert.equal(result.result.endpoint.defaultActive, false)
        assert.match(result.text, /conditional default inactive/)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})
