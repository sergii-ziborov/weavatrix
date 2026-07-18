import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(ROOT, 'fixtures', name)

export const BENCHMARK_SCHEMA = 'weavatrix.benchmark.v1'
export const BENCHMARK_BASELINE = '0.2.1'
export const BENCHMARK_BUDGETS = Object.freeze({
    maxCaseGraphBytes: 128 * 1024,
    maxCaseColdMs: 15_000,
    maxTotalColdMs: 60_000,
    maxReportBytes: 64 * 1024,
    maxTextResponseBytes: 64 * 1024,
    maxReconnectMs: 10_000,
})

export const GOLDEN_CASES = Object.freeze([
    {
        id: 'typescript', language: 'TypeScript', root: fixture('typescript'),
        symbols: ['get', 'loadUser', 'bootstrap'],
        edges: [
            {relation: 'imports', source: 'src/users.ts', target: 'src/http.ts', provenance: 'RESOLVED'},
            {relation: 'calls', source: 'src/users.ts#loadUser@', target: 'src/http.ts#get@', provenance: 'INFERRED'},
        ],
    },
    {
        id: 'javascript', language: 'JavaScript', root: fixture('javascript'),
        symbols: ['compileQuery', 'executeQuery', 'run'],
        edges: [
            {relation: 'imports', source: 'src/service.js', target: 'src/query.js', provenance: 'RESOLVED'},
            {relation: 'calls', source: 'src/service.js#executeQuery@', target: 'src/query.js#compileQuery@', provenance: 'INFERRED'},
        ],
    },
    {
        id: 'python', language: 'Python', root: fixture('python'),
        symbols: ['normalize_name', 'load_user', 'bootstrap'],
        edges: [
            {relation: 'imports', source: 'service.py', target: 'utils.py', provenance: 'RESOLVED'},
            {relation: 'calls', source: 'service.py#load_user@', target: 'utils.py#normalize_name@', provenance: 'INFERRED'},
        ],
    },
    {
        id: 'go', language: 'Go', root: fixture('go'),
        symbols: ['FormatName', 'LoadUser', 'main'],
        edges: [
            {relation: 'calls', source: 'service.go#LoadUser@', target: 'format.go#FormatName@', provenance: 'INFERRED'},
        ],
    },
    {
        id: 'java', language: 'Java', root: fixture('java'),
        symbols: ['UserReader', 'User', 'UserStore', 'save', 'BaseService', 'UserService', 'cached', 'load'],
        edges: [
            {relation: 'inherits', source: 'UserService.java#UserService@', target: 'BaseService.java#BaseService@', provenance: 'INFERRED'},
            {relation: 'implements', source: 'UserService.java#UserService@', target: 'UserReader.java#UserReader@', provenance: 'INFERRED'},
            {relation: 'references', source: 'UserService.java#load@', target: 'User.java#User@', provenance: 'INFERRED'},
            {relation: 'method', source: 'UserService.java#UserService@', target: 'UserService.java#load@', provenance: 'EXTRACTED'},
            {relation: 'calls', source: 'UserService.java#load@', target: 'UserStore.java#save@', provenance: 'INFERRED'},
        ],
    },
    {
        id: 'rust', language: 'Rust', root: fixture('rust'),
        symbols: ['User', 'get_user', 'router'],
        edges: [
            {relation: 'imports', source: 'src/lib.rs', target: 'src/routes.rs', compileOnly: true, provenance: 'RESOLVED'},
            {relation: 'imports', source: 'src/routes.rs', target: 'src/model.rs', compileOnly: true, provenance: 'RESOLVED'},
        ],
        endpoints: [{method: 'GET', path: '/api/users/:id', handler: 'get_user'}],
    },
])

export const CROSS_REPO_CASE = Object.freeze({
    backend: fixture('crossrepo-backend'),
    frontend: fixture('crossrepo-frontend'),
})
