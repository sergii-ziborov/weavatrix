import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {graphStorageKey} from '../src/graph/layout.js'
import {liveRepositoryRecords, readRepositoryRegistry, registerRepository} from '../src/graph/repo-registry.js'

const REGISTRY_MODULE = fileURLToPath(new URL('../src/graph/repo-registry.js', import.meta.url))

const childRegister = (repo, graphDir, graphHome) => new Promise((resolve, reject) => {
  const source = `import {registerRepository} from ${JSON.stringify(pathToFileURL(REGISTRY_MODULE).href)}; const r=registerRepository({repoPath:process.argv[1],graphDir:process.argv[2],graphHome:process.argv[3]}); process.stdout.write(r.repositoryId)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, repo, graphDir, graphHome], {windowsHide: true})
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${code}`)))
})

test('repository registry keeps one stable UUID under multi-process registration', {timeout: 30_000}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'weavatrix-registry-race-'))
  const repo = join(root, 'repo')
  const graphHome = join(root, 'graphs')
  try {
    mkdirSync(join(repo, '.git'), {recursive: true})
    const graphDir = join(graphHome, graphStorageKey(repo))
    mkdirSync(graphDir, {recursive: true})
    writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({nodes: [], links: []}))
    const ids = await Promise.all(Array.from({length: 8}, () => childRegister(repo, graphDir, graphHome)))
    assert.equal(new Set(ids).size, 1)
    const raw = readRepositoryRegistry(graphHome)
    assert.equal(raw.length, 1)
    assert.equal(raw[0].repositoryId, ids[0])
    assert.equal(readFileSync(join(graphDir, '.repository-id'), 'utf8').trim(), ids[0])
    assert.equal(liveRepositoryRecords(graphHome).length, 1)
  } finally { rmSync(root, {recursive: true, force: true}) }
})

test('live registry rejects a tampered non-canonical graph path', () => {
  const root = mkdtempSync(join(tmpdir(), 'weavatrix-registry-tamper-'))
  const repo = join(root, 'repo')
  const graphHome = join(root, 'graphs')
  try {
    mkdirSync(join(repo, '.git'), {recursive: true})
    const graphDir = join(graphHome, graphStorageKey(repo))
    mkdirSync(graphDir, {recursive: true})
    writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({nodes: [], links: []}))
    const registered = registerRepository({repoPath: repo, graphDir, graphHome})
    const outside = join(root, 'outside')
    mkdirSync(outside, {recursive: true})
    writeFileSync(join(outside, 'graph.json'), JSON.stringify({nodes: [], links: []}))
    writeFileSync(join(outside, '.repository-id'), `${registered.repositoryId}\n`)
    writeFileSync(join(graphHome, 'repositories.json'), JSON.stringify({repositoryRegistryV: 1, repositories: [{...registered, graphDir: outside}]}))
    assert.deepEqual(liveRepositoryRecords(graphHome), [])
  } finally { rmSync(root, {recursive: true, force: true}) }
})
