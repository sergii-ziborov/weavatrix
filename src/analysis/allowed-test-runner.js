import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createRepoBoundary} from '../repo-path.js'
import {runCommand} from '../process.js'

const SAFE_SCRIPT = /^(?:test(?::|$)|(?:check|verify)(?::|$)|[^:]+:(?:test|check|verify)(?::|$))/i
const UNSAFE_SHELL_ARG = /[\0\r\n&|<>^%!`\"]/
const tail = (value, limit = 8000) => String(value || '').slice(-limit)

function manifestAt(repoRoot) {
  const resolved = createRepoBoundary(repoRoot).resolve('package.json')
  if (!resolved.ok) return null
  try { return JSON.parse(readFileSync(resolved.path, 'utf8')) } catch { return null }
}

function packageManager(repoRoot) {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export function validateTestRequests(repoRoot, requests = []) {
  const manifest = manifestAt(repoRoot)
  if (!manifest) return {ok: false, reason: 'package.json is missing or unreadable', tests: []}
  const tests = []
  for (const request of requests.slice(0, 5)) {
    const script = String(request?.script || '')
    const args = Array.isArray(request?.args) ? request.args.slice(0, 40).map(String) : []
    if (!SAFE_SCRIPT.test(script)) return {ok: false, reason: `script ${script || '(missing)'} is outside the test/check/verify allowlist`, tests}
    if (!Object.hasOwn(manifest.scripts || {}, script)) return {ok: false, reason: `package.json has no script named ${script}`, tests}
    if (args.some((arg) => arg.length > 300 || UNSAFE_SHELL_ARG.test(arg))) return {ok: false, reason: `script ${script} has an invalid or shell-sensitive argument`, tests}
    tests.push({script, args})
  }
  return {ok: true, tests, packageManager: packageManager(repoRoot)}
}

export async function runAllowedTests(repoRoot, requests = [], {enabled = false, timeoutMs = 60_000} = {}) {
  const checked = validateTestRequests(repoRoot, requests)
  if (!checked.ok) return {state: 'BLOCKED', reason: checked.reason, results: []}
  if (!checked.tests.length) return {state: 'NOT_REQUESTED', reason: 'no package scripts were requested', results: []}
  if (!enabled || process.env.WEAVATRIX_ALLOW_TEST_RUNS !== '1') return {
    state: 'DISABLED', reason: 'set WEAVATRIX_ALLOW_TEST_RUNS=1 and pass run_tests:true to execute allowlisted package scripts',
    plan: checked.tests, results: [],
  }
  const results = []
  const timeout = Math.max(1000, Math.min(300_000, Number(timeoutMs) || 60_000))
  for (const test of checked.tests) {
    const start = Date.now()
    const separator = checked.packageManager === 'yarn' ? [] : ['--']
    try {
      const run = await runCommand(checked.packageManager, ['run', test.script, ...separator, ...test.args], {cwd: repoRoot, timeoutMs: timeout})
      results.push({script: test.script, status: run.exitCode === 0 ? 'PASS' : 'FAIL', exitCode: run.exitCode, durationMs: Date.now() - start, stdoutTail: tail(run.stdout), stderrTail: tail(run.stderr)})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({script: test.script, status: /timed out/i.test(message) ? 'TIMEOUT' : 'FAIL', exitCode: null, durationMs: Date.now() - start, stdoutTail: '', stderrTail: tail(message)})
    }
  }
  return {state: results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL', packageManager: checked.packageManager, results}
}
