import {createHash} from 'node:crypto'
import {readFileSync, realpathSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {isPathInside} from '../repo-path.js'

// Exact SHA-256 allowlist for the parser artifacts shipped by the package-pinned
// web-tree-sitter@0.25.10 and tree-sitter-wasms@0.1.13 dependencies. npm integrity
// protects installation; this second boundary detects replacement or redirection
// before Emscripten compiles a runtime or dynamic language module.
const RUNTIME_SHA256 = 'f38dcc4b43b818f9a0785bc1c6d5611a75ac4cdd428ff3f02757c34ca4e46d7f'
const GRAMMAR_SHA256 = Object.freeze({
  javascript: '63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5',
  typescript: '8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f',
  tsx: '6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6',
  python: '9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b',
  go: '9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6',
  java: '637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f',
  c_sharp: '6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991',
  rust: '4409921a70d0aa5bec7d1d7ce809a557a8ee1cf6ace901e3ac6a76e62cfea903',
  html: '11b3405c1543fb012f5ed7f8ee73125076dce8b168301e1e787e4c717da6b456',
  css: '5fc615467b1b98420ed7517e5bf9e1f88468132dd903d842dfb13714f6a1cb0c',
})

export function verifyParserArtifact({file, root, sha256, label = 'parser artifact'}) {
  let rootReal, fileReal
  try {
    rootReal = realpathSync.native(root)
    fileReal = realpathSync.native(file)
  } catch {
    throw new Error(`${label} is missing or cannot be resolved`)
  }
  if (!isPathInside(rootReal, fileReal) || !statSync(fileReal).isFile()) {
    throw new Error(`${label} resolves outside its pinned package directory`)
  }
  const actual = createHash('sha256').update(readFileSync(fileReal)).digest('hex')
  if (actual !== sha256) throw new Error(`${label} failed the pinned SHA-256 integrity check`)
  return fileReal
}

export function trustedRuntimeWasm(wtsDir) {
  return verifyParserArtifact({
    file: join(wtsDir, 'tree-sitter.wasm'), root: wtsDir,
    sha256: RUNTIME_SHA256, label: 'web-tree-sitter runtime',
  })
}

export function trustedGrammarWasm(wasmDir, grammar) {
  const sha256 = GRAMMAR_SHA256[grammar]
  if (!sha256) throw new Error(`unsupported tree-sitter grammar: ${grammar}`)
  return verifyParserArtifact({
    file: join(wasmDir, `tree-sitter-${grammar}.wasm`), root: wasmDir,
    sha256, label: `tree-sitter ${grammar} grammar`,
  })
}
