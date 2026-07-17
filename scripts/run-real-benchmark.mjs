import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { baselineFromReport, REAL_BASELINE, runRealRepositoryBenchmark } from '../benchmark/real-runner.mjs'

const args = process.argv.slice(2)
const value = (flag) => {
    const index = args.indexOf(flag)
    if (index < 0) return null
    if (!args[index + 1]) throw new Error(`${flag} requires a value`)
    return args[index + 1]
}
const requireAll = args.includes('--require-all')
const updateBaseline = args.includes('--update-baseline')
const output = value('--output')
const builderPath = value('--builder')
let builder
if (builderPath) {
    const module = await import(pathToFileURL(resolve(builderPath)).href)
    builder = module.buildInternalGraph
    if (typeof builder !== 'function') throw new Error('--builder module must export buildInternalGraph')
}

const report = await runRealRepositoryBenchmark({...(builder ? {builder} : {})})
if (updateBaseline) {
    const version = value('--baseline-version') || report.baselineVersion
    writeFileSync(REAL_BASELINE, `${JSON.stringify(baselineFromReport(report, version), null, 2)}\n`, 'utf8')
}
const json = `${JSON.stringify(report, null, 2)}\n`
if (output) writeFileSync(resolve(output), json, 'utf8')
process.stdout.write(json)
if (report.status === 'FAIL' || (requireAll && report.status !== 'PASS')) process.exitCode = 1
