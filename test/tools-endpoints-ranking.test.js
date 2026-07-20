import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadGraph} from '../src/mcp/graph-context.mjs'
import {tTraceEndpoint} from '../src/mcp/tools-endpoints.mjs'

test('trace_endpoint same-directory handler outranks an import-bound same-named impostor', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-endpoint-samedir-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'api'), {recursive: true})
        mkdirSync(join(repo, 'store'), {recursive: true})
        writeFileSync(join(repo, 'api', 'routes.js'), "import {open} from '../store/users.js'\nrouter.get('/users', getUsers)\n")
        writeFileSync(join(repo, 'api', 'handlers.js'), 'export function getUsers() { return db.find() }\n')
        writeFileSync(join(repo, 'store', 'users.js'), 'export function getUsers() { return rows }\nexport function open() {}\n')
        const files = ['api/routes.js', 'api/handlers.js', 'store/users.js']
        const nodes = files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'}))
        nodes.push(
            {id: 'api/handlers.js#getUsers@1', label: 'getUsers()', source_file: 'api/handlers.js', source_location: 'L1', file_type: 'code'},
            {id: 'store/users.js#getUsers@1', label: 'getUsers()', source_file: 'store/users.js', source_location: 'L1', file_type: 'code'},
        )
        writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, nodes, links: [
            {source: 'api/routes.js', target: 'store/users.js', relation: 'imports', provenance: 'EXTRACTED'},
        ]}))
        const result = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET'}, {repoRoot: repo})
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.handler.file, 'api/handlers.js', 'a same-package/-directory handler must beat a merely import-bound file with the same symbol name')
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('trace_endpoint handler_file rescues a candidate the ranking would collapse away', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-endpoint-rescue-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'lib'), {recursive: true})
        mkdirSync(join(repo, 'plugins'), {recursive: true})
        writeFileSync(join(repo, 'routes.js'), "import {helper} from './lib/util.js'\nrouter.get('/report', buildReport)\n")
        writeFileSync(join(repo, 'lib', 'util.js'), 'export function buildReport() { return template() }\n')
        writeFileSync(join(repo, 'plugins', 'report.js'), 'export function buildReport() { return real() }\n')
        const files = ['routes.js', 'lib/util.js', 'plugins/report.js']
        const nodes = files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'}))
        nodes.push(
            {id: 'lib/util.js#buildReport@1', label: 'buildReport()', source_file: 'lib/util.js', source_location: 'L1', file_type: 'code'},
            {id: 'plugins/report.js#buildReport@1', label: 'buildReport()', source_file: 'plugins/report.js', source_location: 'L1', file_type: 'code'},
        )
        writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, nodes, links: [
            {source: 'routes.js', target: 'lib/util.js', relation: 'imports', provenance: 'EXTRACTED'},
        ]}))
        const unhinted = tTraceEndpoint(loadGraph(graphPath), {path: '/report', method: 'GET'}, {repoRoot: repo})
        assert.equal(unhinted.result.handler.file, 'lib/util.js', 'ranking alone picks the import-bound candidate')
        const hinted = tTraceEndpoint(loadGraph(graphPath), {path: '/report', method: 'GET', handler_file: 'plugins/report.js'}, {repoRoot: repo})
        assert.equal(hinted.result.status, 'COMPLETE')
        assert.equal(hinted.result.handler.file, 'plugins/report.js', 'the hint must reach candidates outside the top-score tie set')
        const cased = tTraceEndpoint(loadGraph(graphPath), {path: '/report', method: 'GET', handler_file: 'Plugins/Report.js'}, {repoRoot: repo})
        assert.equal(cased.result.handler.file, 'plugins/report.js', 'hint matching is case-insensitive')
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})

test('trace_endpoint exact handler_file match beats a suffix match', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-endpoint-suffix-'))
    const graphPath = join(repo, 'graph.json')
    try {
        mkdirSync(join(repo, 'src', 'app'), {recursive: true})
        mkdirSync(join(repo, 'legacy', 'src', 'app'), {recursive: true})
        writeFileSync(join(repo, 'routes.js'), "router.get('/users', getUser)\n")
        writeFileSync(join(repo, 'src', 'app', 'user.js'), 'export function getUser() { return db.find() }\n')
        writeFileSync(join(repo, 'legacy', 'src', 'app', 'user.js'), 'export function getUser() { return old() }\n')
        const files = ['routes.js', 'src/app/user.js', 'legacy/src/app/user.js']
        const nodes = files.map((file) => ({id: file, label: file, source_file: file, file_type: 'code'}))
        nodes.push(
            {id: 'src/app/user.js#getUser@1', label: 'getUser()', source_file: 'src/app/user.js', source_location: 'L1', file_type: 'code'},
            {id: 'legacy/src/app/user.js#getUser@1', label: 'getUser()', source_file: 'legacy/src/app/user.js', source_location: 'L1', file_type: 'code'},
        )
        writeFileSync(graphPath, JSON.stringify({repoBoundaryV: 1, edgeTypesV: 2, edgeProvenanceV: 1, nodes, links: []}))
        const result = tTraceEndpoint(loadGraph(graphPath), {path: '/users', method: 'GET', handler_file: 'src/app/user.js'}, {repoRoot: repo})
        assert.equal(result.result.status, 'COMPLETE')
        assert.equal(result.result.handler.file, 'src/app/user.js', 'the exact repo-relative path from the AMBIGUOUS_HANDLER message must always disambiguate')
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})
