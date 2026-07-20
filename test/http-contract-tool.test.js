import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {registerRepository} from '../src/graph/repo-registry.js'
import {graphStorageKey} from '../src/graph/layout.js'
import {tTraceApiContract} from '../src/mcp/tools-company.mjs'

function write(root, file, value) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), {recursive: true})
    writeFileSync(path, value)
}

function registerFixture(graphHome, root, graph) {
    mkdirSync(join(root, '.git'), {recursive: true})
    const graphDir = join(graphHome, graphStorageKey(root))
    mkdirSync(graphDir, {recursive: true})
    writeFileSync(join(graphDir, 'graph.json'), JSON.stringify(graph))
    return registerRepository({repoPath: root, graphDir, graphHome})
}

test('trace_api_contract refreshes registered graphs and returns verdict-first bounded evidence', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'wx-http-tool-'))
    const graphHome = join(workspace, 'graphs')
    const backendRoot = join(workspace, 'backend-api')
    const clientRoot = join(workspace, 'frontend-web')
    mkdirSync(backendRoot, {recursive: true})
    mkdirSync(clientRoot, {recursive: true})
    write(backendRoot, 'src/routes.js', "router.get('/api/users/:id', getUser); router.post('/api/users', createUser);")
    write(clientRoot, 'src/api/users.ts', 'export const getUser = (id) => axios.get(`/api/users/${id}`);')
    write(clientRoot, 'src/pages/UsersPage.tsx', "import { getUser } from '../api/users'; export const UsersPage = () => getUser(1);")
    const backend = registerFixture(graphHome, backendRoot, {
        repoBoundaryV: 1, edgeTypesV: 2, graphBuildMode: 'no-tests',
        nodes: [{id: 'routes', source_file: 'src/routes.js'}], links: [],
    })
    const client = registerFixture(graphHome, clientRoot, {
        repoBoundaryV: 1, edgeTypesV: 2, graphBuildMode: 'no-tests',
        nodes: [
            {id: 'api', source_file: 'src/api/users.ts'},
            {id: 'page', source_file: 'src/pages/UsersPage.tsx'},
        ],
        links: [{source: 'page', target: 'api', relation: 'imports'}],
    })

    try {
        const result = await tTraceApiContract(null, {
            backend: backend.repositoryId,
            clients: ['frontend-web'],
            transport: 'http',
            method: 'GET',
            path: '/api/users/{id}',
            changed_files: ['src/routes.js'],
            max_impact_depth: 2,
        }, {graphHome})
        assert.equal(result.__weavatrixToolResult, true)
        assert.match(result.text, /^VERDICT CLIENTS_AT_RISK/)
        assert.equal(result.result.crossRepoHttpContractV, 3)
        assert.equal(result.result.transportContracts.transportContractsV, 2)
        assert.equal(result.result.verdict.callsites, 1)
        assert.equal(result.result.verdict.affectedScreens, 1)
        assert.equal(result.result.totals.endpoints, 1)
        assert.equal(result.result.endpoints[0].liveness.status, 'NOT_DEAD_EXTERNAL_USE')
        assert.match(result.text, /NOT_DEAD_EXTERNAL_USE/)
        assert.equal(result.result.repositories.backend.repositoryId, backend.repositoryId)
        assert.equal(result.result.repositories.clients[0].repositoryId, client.repositoryId)
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.graphReconciliation.length, 2)
        assert.equal(result.result.graphReconciliation.every((item) => ['CURRENT', 'REFRESHED'].includes(item.status)), true)
        assert.equal(result.result.graphReconciliation.every((item) => item.buildMode === 'no-tests'), true)
        assert.deepEqual(result.result.endpoints[0].affected.files.map((item) => [item.file, item.distance]), [
            ['src/api/users.ts', 0],
            ['src/pages/UsersPage.tsx', 1],
        ])
        assert.doesNotMatch(JSON.stringify(result), new RegExp(workspace.replace(/[\\/]/g, '[\\\\/]'), 'i'))

        // A new client source file is added after the first graph build. The next trace must reconcile
        // the registered client graph instead of silently reusing stale graph.json evidence.
        write(clientRoot, 'src/pages/AdminPage.tsx', "import { getUser } from '../api/users'; export const AdminPage = () => getUser(2);")
        const refreshed = await tTraceApiContract(null, {
            backend: backend.repositoryId,
            clients: ['frontend-web'],
            transport: 'http',
            method: 'GET',
            path: '/api/users/{id}',
            max_impact_depth: 2,
        }, {graphHome})
        assert.equal(refreshed.result.status, 'COMPLETE')
        assert.equal(refreshed.result.verdict.affectedScreens, 2)
        assert.equal(refreshed.result.endpoints[0].affected.screens.some((item) => item.file === 'src/pages/AdminPage.tsx'), true)
        const clientRefresh = refreshed.result.graphReconciliation.find((item) => item.repository.repositoryId === client.repositoryId)
        assert.equal(clientRefresh.status, 'REFRESHED')
        assert.equal(clientRefresh.buildMode, 'no-tests')
        assert.equal(clientRefresh.refresh.kind, 'full', 'filtered graphs refresh safely without switching universes')

        const unknown = await tTraceApiContract(null, {backend: 'missing', clients: ['frontend-web']}, {graphHome})
        assert.match(unknown.text, /^VERDICT INVALID_REPOSITORY/)
        assert.equal(unknown.result.status, 'INVALID_REPOSITORY')
        assert.equal(JSON.stringify(unknown.result).includes(backendRoot), false)
    } finally {
        rmSync(workspace, {recursive: true, force: true})
    }
})

test('trace_api_contract surfaces method mismatches on endpoints ranked out of top_n', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'wx-http-tool-mismatch-'))
    const graphHome = join(workspace, 'graphs')
    const backendRoot = join(workspace, 'backend-api')
    const clientRoot = join(workspace, 'frontend-web')
    mkdirSync(backendRoot, {recursive: true})
    mkdirSync(clientRoot, {recursive: true})
    write(backendRoot, 'src/routes.js', "router.get('/api/users/:id', getUser); router.delete('/api/items/:id', deleteItem);")
    write(clientRoot, 'src/api/users.ts', 'export const getUser = (id) => axios.get(`/api/users/${id}`);')
    write(clientRoot, 'src/api/items.ts', 'export const fetchItem = (id) => axios.get(`/api/items/${id}`);')
    const backend = registerFixture(graphHome, backendRoot, {
        repoBoundaryV: 1, edgeTypesV: 2, graphBuildMode: 'no-tests',
        nodes: [{id: 'routes', source_file: 'src/routes.js'}], links: [],
    })
    registerFixture(graphHome, clientRoot, {
        repoBoundaryV: 1, edgeTypesV: 2, graphBuildMode: 'no-tests',
        nodes: [
            {id: 'api', source_file: 'src/api/users.ts'},
            {id: 'items', source_file: 'src/api/items.ts'},
        ],
        links: [],
    })

    try {
        // The DELETE endpoint has zero matching callsites, so top_n:1 drops it from the ranked rows —
        // its wrong-method caller must still surface through the dedicated mismatch block.
        const result = await tTraceApiContract(null, {
            backend: backend.repositoryId,
            clients: ['frontend-web'],
            transport: 'http',
            top_n: 1,
        }, {graphHome})
        assert.match(result.text, /^VERDICT CLIENTS_AT_RISK_WITH_METHOD_MISMATCHES/)
        assert.match(result.text, /Method mismatches \(1 call\(s\)\):/)
        assert.match(result.text, /DELETE \/api\/items\/:id — 1 call\(s\) use a different method/)
        assert.match(result.text, /caller frontend-web:src\/api\/items\.ts:\d+ uses GET/)
        assert.doesNotMatch(result.text, /DELETE \/api\/items\/:id .*→ 0 callsite/, 'the mismatch-only endpoint stays outside the ranked rows')
        assert.equal(result.result.verdict.methodMismatches, 1)
        assert.equal(result.result.endpoints.find((endpoint) => endpoint.method === 'DELETE').methodMismatches, 1)
    } finally {
        rmSync(workspace, {recursive: true, force: true})
    }
})
