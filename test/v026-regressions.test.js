import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {tmpdir} from 'node:os'
import {buildInternalGraph} from '../src/graph/internal-builder.js'
import {loadGraph} from '../src/mcp/graph-context.mjs'
import {tContextBundle} from '../src/mcp/tools-context.mjs'
import {tInspectSymbol} from '../src/mcp/tools-source.mjs'

function repository(files) {
    const root = mkdtempSync(join(tmpdir(), 'weavatrix-v026-'))
    for (const [file, source] of Object.entries(files)) {
        const path = join(root, file)
        mkdirSync(dirname(path), {recursive: true})
        writeFileSync(path, source)
    }
    return root
}

test('TypeScript type and value declarations keep separate graph identities', async () => {
    const root = repository({
        'src/model.ts': [
            'export interface Account { id: string }',
            'export const Account = { kind: "runtime" };',
            'export type Alias = Account;',
            'export enum Status { Ok }',
        ].join('\n'),
        'src/use.ts': [
            "import { Account, type Alias, Status } from './model';",
            'export function use(value: Alias): string {',
            '  return Account.kind + Status.Ok + value.id;',
            '}',
        ].join('\n'),
    })
    try {
        const graph = await buildInternalGraph(root)
        assert.equal(graph.symbolSpacesV, 1)
        assert.equal(graph.extractorSchemaV, 7)
        const accounts = graph.nodes.filter((node) => node.source_file === 'src/model.ts' && node.label === 'Account')
        assert.equal(accounts.length, 2)
        const accountType = accounts.find((node) => node.symbol_space === 'type')
        const accountValue = accounts.find((node) => node.symbol_space === 'value')
        assert.equal(accountType.symbol_kind, 'interface')
        assert.match(accountType.id, /:type$/)
        assert.equal(accountValue.symbol_kind, 'variable')
        const status = graph.nodes.find((node) => node.source_file === 'src/model.ts' && node.label === 'Status')
        assert.equal(status.symbol_space, 'both')
        const alias = graph.nodes.find((node) => node.source_file === 'src/model.ts' && node.label === 'Alias')
        const use = graph.nodes.find((node) => node.source_file === 'src/use.ts' && node.label === 'use()')
        assert.ok(graph.links.some((link) => link.source === use.id && link.target === alias.id
            && link.relation === 'references' && link.typeOnly === true))
        assert.ok(!graph.links.some((link) => link.target === accountType.id && link.relation === 'calls'))
    } finally { rmSync(root, {recursive: true, force: true}) }
})

test('context_bundle aggregates graph relations and exact re-export occurrences', async () => {
    const root = repository({
        'src/origin.ts': 'export function run(){ return 1; }\nexport interface Shape { id: string }\nfunction hidden(){}\n',
        'src/leaf.ts': "export { run as execute, type Shape as PublicShape } from './origin';\n",
        'src/index.ts': "export * from './leaf';\n",
        'src/public.ts': "export { execute as start } from './index';\n",
        'src/use.ts': "import { start } from './public';\nexport function use(){ return start(); }\n",
    })
    try {
        const raw = await buildInternalGraph(root)
        assert.equal(raw.reExportOccurrencesV, 1)
        assert.ok(raw.reExportOccurrences.every((site) => Number.isInteger(site.line) && site.file))
        const graphPath = join(root, 'graph.json')
        writeFileSync(graphPath, JSON.stringify(raw))
        const graph = loadGraph(graphPath)
        const run = graph.nodes.find((node) => node.source_file === 'src/origin.ts' && node.label === 'run()')
        const bundle = await tContextBundle(graph, {
            label: run.id,
            precision: 'graph',
            max_related: 5,
            max_reexports: 10,
            max_source_files: 3,
            context_lines: 1,
        }, {repoRoot: root, graphPath}, tInspectSymbol)
        assert.equal(bundle.result.status, 'OK')
        assert.equal(bundle.result.definition.space, 'value')
        assert.equal(bundle.result.inbound.total, 1)
        assert.equal(bundle.result.reExports.total, 3)
        assert.deepEqual(bundle.result.reExports.shown.map((site) => `${site.file}:${site.line}:${site.exported}`), [
            'src/index.ts:1:execute',
            'src/leaf.ts:1:execute',
            'src/public.ts:1:start',
        ])
        assert.ok(bundle.result.source.length <= 3)
        assert.ok(Buffer.byteLength(JSON.stringify(bundle.result), 'utf8') < 64 * 1024)
        assert.match(bundle.text, /Inbound: 1 container/)
        assert.match(bundle.text, /Re-export sites: 3/)

        const hidden = graph.nodes.find((node) => node.source_file === 'src/origin.ts' && node.label === 'hidden()')
        const privateBundle = await tContextBundle(graph, {label: hidden.id, precision: 'graph'}, {repoRoot: root, graphPath}, tInspectSymbol)
        assert.equal(privateBundle.result.definition.exported, false)
        assert.equal(privateBundle.result.reExports.total, 0, 'export-star must not expose a private declaration')
    } finally { rmSync(root, {recursive: true, force: true}) }
})

test('context_bundle reports outbound call-site files and excerpts instead of target-file/line hybrids', async () => {
    const root = repository({
        'src/service.ts': 'export function mitigate(id: string){ return id; }\n',
        'src/controller.ts': [
            "import {mitigate} from './service';",
            'export async function startMitigate(id: string){',
            '  /*',
            '   * deliberately long controller documentation',
            '   * line five',
            '   * line six',
            '   * line seven',
            '   */',
            '  return mitigate(id);',
            '}',
        ].join('\n'),
    })
    try {
        const raw = await buildInternalGraph(root)
        const graphPath = join(root, 'graph.json')
        writeFileSync(graphPath, JSON.stringify(raw))
        const graph = loadGraph(graphPath)
        const controller = graph.nodes.find((node) => node.source_file === 'src/controller.ts' && node.label === 'startMitigate()')
        const bundle = await tContextBundle(graph, {
            label: controller.id,
            precision: 'graph',
            max_related: 5,
            max_source_files: 4,
            context_lines: 1,
        }, {repoRoot: root, graphPath}, tInspectSymbol)
        const call = bundle.result.outbound.shown.find((group) => group.label === 'mitigate()')
        assert.equal(call.file, 'src/controller.ts', 'edge line is paired with its source/call-site file')
        assert.equal(call.targetFile, 'src/service.ts')
        assert.ok(call.lines.includes(9))
        const excerpt = bundle.result.source.find((item) => item.role === 'Outbound call site')
        assert.equal(excerpt.file, 'src/controller.ts')
        assert.match(excerpt.text, /return mitigate\(id\)/)
        assert.match(bundle.text, /call site src\/controller\.ts:9 → src\/service\.ts/)
    } finally { rmSync(root, {recursive: true, force: true}) }
})

test('context_bundle ranks production inbound callers first, gates classified callers, and avoids overlapping excerpts', async () => {
    const root = repository({
        'src/service.ts': 'export function helper(){ return 1; }\nexport function work(){ return helper(); }\n',
        'src/controller.ts': "import {work} from './service';\nexport function run(){ return work(); }\n",
        'test/work.test.ts': [
            "import {work} from '../src/service';",
            'export function exercise(){',
            '  work();',
            '  work();',
            '  return work();',
            '}',
        ].join('\n'),
    })
    try {
        const raw = await buildInternalGraph(root)
        const graphPath = join(root, 'graph.json')
        writeFileSync(graphPath, JSON.stringify(raw))
        const graph = loadGraph(graphPath)
        const work = graph.nodes.find((node) => node.source_file === 'src/service.ts' && node.label === 'work()')
        const production = await tContextBundle(graph, {
            label: work.id, precision: 'graph', max_related: 10, max_source_files: 6, context_lines: 1,
        }, {repoRoot: root, graphPath}, tInspectSymbol)
        assert.equal(production.result.inbound.total, 1)
        assert.equal(production.result.inbound.available, 2)
        assert.equal(production.result.inbound.suppressed, 1)
        assert.equal(production.result.inbound.shown[0].file, 'src/controller.ts')
        assert.doesNotMatch(production.text, /test\/work\.test\.ts/)

        const complete = await tContextBundle(graph, {
            label: work.id, precision: 'graph', include_classified: true,
            max_related: 10, max_source_files: 6, context_lines: 1,
        }, {repoRoot: root, graphPath}, tInspectSymbol)
        assert.deepEqual(complete.result.inbound.shown.map((group) => group.file), [
            'src/controller.ts',
            'test/work.test.ts',
        ], 'production caller stays first even when the classified caller has more call sites')
        assert.match(complete.text, /classified:test/)
        for (let left = 0; left < complete.result.source.length; left++) for (let right = left + 1; right < complete.result.source.length; right++) {
            const a = complete.result.source[left]
            const b = complete.result.source[right]
            assert.ok(a.file !== b.file || a.endLine < b.startLine || b.endLine < a.startLine,
                `source excerpts overlap in ${a.file}: ${a.startLine}-${a.endLine} and ${b.startLine}-${b.endLine}`)
        }
    } finally { rmSync(root, {recursive: true, force: true}) }
})
