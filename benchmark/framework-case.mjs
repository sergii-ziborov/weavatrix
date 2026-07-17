import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInternalGraph } from '../src/graph/internal-builder.js'
import { detectEndpoints } from '../src/analysis/endpoints.js'
import { runInternalAudit } from '../src/analysis/internal-audit.js'

export const FRAMEWORK_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'framework-conventions')

export async function benchmarkFrameworkConventions() {
    const graph = await buildInternalGraph(FRAMEWORK_FIXTURE)
    const files = [...new Set(graph.nodes.map((node) => node.source_file).filter(Boolean))].sort()
    const endpoints = detectEndpoints(FRAMEWORK_FIXTURE, files)
    const audit = await runInternalAudit(FRAMEWORK_FIXTURE, {
        graph, skipMalwareScan: true, advisoryStorePath: join(FRAMEWORK_FIXTURE, '.missing-advisories.json'),
    })
    const unused = new Set(audit.findings.filter((finding) => finding.rule === 'unused-dep').map((finding) => finding.package))
    const noisyFiles = new Set(['app/api/users/route.ts', 'resources/runtime/worker.py', 'src/generated/client.ts', 'e2e/app.fixture.ts'])
    const noisyFinding = audit.findings.find((finding) => noisyFiles.has(finding.file)
        && ['unused-file', 'unused-export', 'orphan-file'].includes(finding.rule))
    const protectedDependencies = [
        'react-dom', '@vitejs/plugin-react', '@vitejs/plugin-rsc', 'react-server-dom-webpack',
        'sass', 'vite', 'wrangler',
    ]
    const assertions = [
        {id: 'next-route-endpoint', pass: endpoints.some((endpoint) => endpoint.method === 'GET' && endpoint.path === '/api/users')},
        ...protectedDependencies.map((dependency) => ({id: `implicit-dependency:${dependency}`, pass: !unused.has(dependency)})),
        {id: 'unused-control-detected', pass: unused.has('unused-control')},
        {id: 'convention-and-classification-noise-suppressed', pass: !noisyFinding},
        {id: 'generated-classified', pass: audit.scanned.pathClassifications?.generated === 1},
        {id: 'e2e-classified', pass: audit.scanned.pathClassifications?.e2e === 1},
    ]
    return {
        id: 'framework-conventions', files: files.length, endpoints: endpoints.length,
        assertions, status: assertions.every((assertion) => assertion.pass) ? 'PASS' : 'FAIL',
    }
}
