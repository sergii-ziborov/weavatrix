import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

export function fixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'weavatrix-evidence-'))
    for (const directory of ['api', 'ui', 'shared']) mkdirSync(join(repo, 'src', directory), {recursive: true})
    writeFileSync(join(repo, 'src', 'api', 'a.js'), 'export const a = () => 1\n')
    writeFileSync(join(repo, 'src', 'ui', 'b.js'), 'export const b = () => 2\n')
    writeFileSync(join(repo, 'src', 'shared', 'c.js'), 'export const c = () => 3\n')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'fixture', version: '1.0.0', dependencies: {'left-pad': '1.3.0'}}))
    writeFileSync(join(repo, '.weavatrix-deps.json'), JSON.stringify({
        forbidden: [{name: 'api-to-ui', severity: 'high', from: 'src/api/**', to: 'src/ui/**'}],
    }))
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({
        name: 'fixture', version: '1.0.0', lockfileVersion: 3,
        packages: {
            '': {name: 'fixture', version: '1.0.0', dependencies: {'left-pad': '1.3.0'}, devDependencies: {'fixture-dev': '2.0.0'}, optionalDependencies: {'fixture-optional': '3.0.0'}},
            'node_modules/left-pad': {version: '1.3.0', dependencies: {'repeat-string': '1.6.1'}},
            'node_modules/repeat-string': {version: '1.6.1'},
            'node_modules/fixture-dev': {version: '2.0.0', dev: true},
            'node_modules/fixture-optional': {version: '3.0.0', optional: true},
        },
    }))
    return repo
}

export function fixtureGraph(secret) {
    const nodes = [
        {id: 'src/api/a.js', file_type: 'code', source_file: 'src/api/a.js'},
        {id: 'src/api/a.js#a@1', label: 'a()', file_type: 'code', source_file: 'src/api/a.js', source_text: secret, complexity: {startLine: 1, endLine: 350, loc: 350, cyclomatic: 35, params: 11, evidence: [secret]}},
        {id: 'src/ui/b.js', file_type: 'code', source_file: 'src/ui/b.js'},
        {id: 'src/ui/b.js#b@1', label: 'b()', file_type: 'code', source_file: 'src/ui/b.js', complexity: {loc: 20, cyclomatic: 2, params: 0}},
        {id: 'src/shared/c.js', file_type: 'code', source_file: 'src/shared/c.js'},
        {id: 'src/shared/c.js#c@1', label: 'x=C:\\Users\\Alice\\private.txt', file_type: 'code', source_file: 'src/shared/c.js', complexity: {loc: 301, cyclomatic: 2, params: 0}},
        {id: 'C:/Users/Alice/private.js#leak@1', label: secret, file_type: 'code', source_file: 'C:/Users/Alice/private.js', source_text: secret, complexity: {loc: 999, cyclomatic: 99, params: 99}},
    ]
    const links = [
        {source: 'src/api/a.js', target: 'src/api/a.js#a@1', relation: 'contains'},
        {source: 'src/ui/b.js', target: 'src/ui/b.js#b@1', relation: 'contains'},
        {source: 'src/api/a.js', target: 'src/ui/b.js', relation: 'imports'},
        {source: 'src/ui/b.js', target: 'src/api/a.js', relation: 'imports'},
        {source: 'src/ui/b.js', target: 'src/shared/c.js', relation: 'imports', typeOnly: true},
        {source: 'src/shared/c.js', target: 'src/api/a.js', relation: 'imports', compileOnly: true},
        {source: '/home/alice/private.js', target: 'src/api/a.js', relation: 'imports', source_text: secret},
    ]
    const externalImports = [
        {file: 'src/api/a.js', spec: 'left-pad', pkg: 'left-pad', ecosystem: 'npm', kind: 'esm', line: 1, source_text: secret},
        {file: 'src/ui/b.js', spec: 'left-pad', pkg: 'left-pad', ecosystem: 'npm', kind: 'esm', line: 1},
        {file: 'C:/Users/Alice/private.js', spec: 'private-package', pkg: 'private-package', ecosystem: 'npm', kind: 'esm', source_text: secret},
    ]
    return {repoBoundaryV: 1, edgeTypesV: 2, complexityV: 1, nodes, links, externalImports, injectedSource: secret}
}
