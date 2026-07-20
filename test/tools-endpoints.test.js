import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadGraph} from '../src/mcp/graph-context.mjs'
import {tTraceEndpoint} from '../src/mcp/tools-endpoints.mjs'
import {tListEndpoints} from '../src/mcp/health/endpoints.mjs'

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

test('trace_endpoint prefers the production handler over a classified test twin', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-endpoint-twin-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'handlers'), {recursive: true})
        mkdirSync(join(repo, '__tests__'), {recursive: true})
        writeFileSync(join(repo, 'routes.js'), "router.get('/users', getUser)\n")
        writeFileSync(join(repo, 'handlers', 'user.js'), 'export function getUser() { return db.find() }\n')
        writeFileSync(join(repo, '__tests__', 'user.js'), 'export function getUser() { return fake() }\n')
        const files = ['routes.js', 'handlers/user.js', '__tests__/user.js']
        const nodes = files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'}))
        nodes.push(
            {id: 'handlers/user.js#getUser@1', label: 'getUser()', source_file: 'handlers/user.js', source_location: 'L1', file_type: 'code'},
            {id: '__tests__/user.js#getUser@1', label: 'getUser()', source_file: '__tests__/user.js', source_location: 'L1', file_type: 'code'},
        )
        writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, nodes, links: []}))
        const result = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET'}, {repoRoot: repo})
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.handler.file, 'handlers/user.js')
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('trace_endpoint ranks same-named twins by the import binding at the route file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-endpoint-import-bound-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'handlers'), {recursive: true})
        mkdirSync(join(repo, 'services'), {recursive: true})
        writeFileSync(join(repo, 'routes.js'), "import {getUser} from './handlers/user.js'\nrouter.get('/users', getUser)\n")
        writeFileSync(join(repo, 'handlers', 'user.js'), 'export function getUser() { return db.find() }\n')
        writeFileSync(join(repo, 'services', 'user.js'), 'export function getUser() { return cache.find() }\n')
        const files = ['routes.js', 'handlers/user.js', 'services/user.js']
        const nodes = files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'}))
        nodes.push(
            {id: 'handlers/user.js#getUser@1', label: 'getUser()', source_file: 'handlers/user.js', source_location: 'L1', file_type: 'code'},
            {id: 'services/user.js#getUser@1', label: 'getUser()', source_file: 'services/user.js', source_location: 'L1', file_type: 'code'},
        )
        const graphFor = (target) => ({repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, nodes, links: [
            {source: 'routes.js', target, relation: 'imports', provenance: 'EXTRACTED'},
        ]})
        writeFileSync(graphPath, JSON.stringify(graphFor('handlers/user.js')))
        let result = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET'}, {repoRoot: repo})
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.handler.file, 'handlers/user.js')
        writeFileSync(graphPath, JSON.stringify(graphFor('services/user.js')))
        result = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET'}, {repoRoot: repo})
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.handler.file, 'services/user.js')
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('trace_endpoint fails closed on symmetric twins and a handler_file hint resolves them', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-endpoint-symmetric-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'handlers'), {recursive: true})
        mkdirSync(join(repo, 'services'), {recursive: true})
        writeFileSync(join(repo, 'routes.js'), "router.get('/users', getUser)\n")
        writeFileSync(join(repo, 'handlers', 'user.js'), 'export function getUser() { return db.find() }\n')
        writeFileSync(join(repo, 'services', 'user.js'), 'export function getUser() { return cache.find() }\n')
        const files = ['routes.js', 'handlers/user.js', 'services/user.js']
        const nodes = files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'}))
        nodes.push(
            {id: 'handlers/user.js#getUser@1', label: 'getUser()', source_file: 'handlers/user.js', source_location: 'L1', file_type: 'code'},
            {id: 'services/user.js#getUser@1', label: 'getUser()', source_file: 'services/user.js', source_location: 'L1', file_type: 'code'},
        )
        writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, nodes, links: []}))
        const ambiguous = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET'}, {repoRoot: repo})
        assert.equal(ambiguous.result.status, 'AMBIGUOUS_HANDLER')
        assert.equal(ambiguous.result.handlers.length, 2)
        assert.ok(ambiguous.result.handlers.every((row) => row.importBoundAtRoute === false))
        assert.ok(ambiguous.result.handlers.every((row) => Array.isArray(row.pathClasses)))
        assert.match(ambiguous.text, /import-bound at route: no/)
        assert.match(ambiguous.text, /pass handler_file/)
        const hinted = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET', handler_file: 'services/user.js'}, {repoRoot: repo})
        assert.equal(hinted.result.status, 'COMPLETE')
        assert.equal(hinted.result.handler.file, 'services/user.js')
        const missed = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET', handler_file: 'nope/user.js'}, {repoRoot: repo})
        assert.equal(missed.result.status, 'HANDLER_NOT_FOUND')
        assert.match(missed.text, /no candidate matched handler_file "nope\/user\.js"/)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('list_endpoints suppresses classified endpoints by default and tags them on opt-in', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-list-endpoints-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'src'), {recursive: true})
        mkdirSync(join(repo, '__tests__'), {recursive: true})
        mkdirSync(join(repo, 'benchmarks'), {recursive: true})
        writeFileSync(join(repo, 'src', 'routes.js'), "router.get('/api/live', liveHandler)\n")
        writeFileSync(join(repo, '__tests__', 'routes.js'), "router.get('/api/testonly', testHandler)\n")
        writeFileSync(join(repo, 'benchmarks', 'routes.js'), "router.get('/api/bench', benchHandler)\n")
        const files = ['src/routes.js', '__tests__/routes.js', 'benchmarks/routes.js']
        writeFileSync(graphPath, JSON.stringify({
            repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1,
            nodes: files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'})),
            links: [],
        }))
        const ctx = {repoRoot: repo, graphPath}
        const byDefault = tListEndpoints(null, {}, ctx)
        assert.match(byDefault.text, /GET\s+\/api\/live/)
        assert.doesNotMatch(byDefault.text, /\/api\/testonly|\/api\/bench/)
        assert.match(byDefault.text, /2 endpoint\(s\) in classified test\/e2e\/generated\/mock\/story\/docs\/benchmark\/temp or explicitly excluded paths were suppressed; pass include_classified:true/)
        assert.equal(byDefault.result.suppressed, 2)
        assert.equal(byDefault.result.pathPolicy, 'production-first')
        assert.equal(byDefault.result.page.total, 1)
        const optIn = tListEndpoints(null, {include_classified: true}, ctx)
        assert.equal(optIn.result.suppressed, 0)
        assert.equal(optIn.result.pathPolicy, 'all')
        assert.equal(optIn.result.page.total, 3)
        assert.match(optIn.text, /\/api\/testonly.*\[classified:test\]/)
        assert.match(optIn.text, /\/api\/bench.*\[classified:benchmark\]/)
        assert.ok(optIn.text.indexOf('/api/live') < optIn.text.indexOf('/api/testonly'), 'production rows come first')
        assert.deepEqual(optIn.result.endpoints.find((e) => e.path === '/api/testonly').pathClasses, ['test'])
        assert.equal(optIn.result.endpoints.find((e) => e.path === '/api/live').pathClasses, undefined)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('list_endpoints reports an all-classified repo as no production endpoints', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-list-endpoints-classified-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, '__tests__'), {recursive: true})
        writeFileSync(join(repo, '__tests__', 'routes.js'), "router.get('/api/testonly', testHandler)\n")
        writeFileSync(graphPath, JSON.stringify({
            repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1,
            nodes: [{id: '__tests__/routes.js', label: '__tests__/routes.js', source_file: '__tests__/routes.js', file_type: 'code'}],
            links: [],
        }))
        const result = tListEndpoints(null, {}, {repoRoot: repo, graphPath})
        assert.match(String(result), /^No production HTTP endpoints detected; 1 endpoint\(s\) in classified/)
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})
