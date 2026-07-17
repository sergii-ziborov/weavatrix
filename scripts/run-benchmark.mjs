import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runGoldenBenchmark } from '../benchmark/runner.mjs'

const args = process.argv.slice(2)
const includeLifecycle = !args.includes('--quick')
const outputAt = args.indexOf('--output')
const output = outputAt >= 0 ? args[outputAt + 1] : null
if (outputAt >= 0 && !output) throw new Error('--output requires a path')

const report = await runGoldenBenchmark({includeLifecycle})
const json = `${JSON.stringify(report, null, 2)}\n`
if (output) writeFileSync(resolve(output), json, 'utf8')
process.stdout.write(json)
if (report.status !== 'PASS') process.exitCode = 1
