import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {buildStructureEvidence} from '../src/mcp/evidence-snapshot.structure.mjs'

test('structure evidence suppresses idiomatic Rust module-tree cycles like local findings do', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wx-evidence-rust-'))
    try {
        const graph = {
            nodes: [
                {id: 'src/foo/mod.rs', label: 'mod.rs', source_file: 'src/foo/mod.rs'},
                {id: 'src/foo/bar.rs', label: 'bar.rs', source_file: 'src/foo/bar.rs'},
                {id: 'src/a/x.rs', label: 'x.rs', source_file: 'src/a/x.rs'},
                {id: 'src/b/y.rs', label: 'y.rs', source_file: 'src/b/y.rs'},
            ],
            links: [
                {source: 'src/foo/mod.rs', target: 'src/foo/bar.rs', relation: 'imports', compileOnly: true},
                {source: 'src/foo/bar.rs', target: 'src/foo/mod.rs', relation: 'imports', compileOnly: true},
                {source: 'src/a/x.rs', target: 'src/b/y.rs', relation: 'imports', compileOnly: true},
                {source: 'src/b/y.rs', target: 'src/a/x.rs', relation: 'imports', compileOnly: true},
            ],
        }
        const evidence = buildStructureEvidence(graph, repo)
        assert.equal(evidence.state, 'COMPLETE')
        const compileCycles = evidence.cycles.items.filter((cycle) => cycle.kind === 'compile-time')
        assert.equal(compileCycles.length, 1, 'only the cross-directory cycle survives')
        assert.deepEqual(compileCycles[0].members, ['src/a/x.rs', 'src/b/y.rs'])
    } finally {
        rmSync(repo, {recursive: true, force: true})
    }
})
