import {spawn} from 'node:child_process'
import {isWeavatrixIgnored} from '../../path-ignore.js'
import {
    boundedHistoryInteger,
    GIT_HISTORY_DEFAULTS as DEFAULTS,
    GIT_HISTORY_HARD_CAPS as HARD_CAPS,
    safeHistoryPath,
} from './options.js'

const HEADER_SEPARATOR = '\x1e'
const FIELD_SEPARATOR = '\x1f'

export function boundedGitCommand(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout = [], stderr = []
        let stdoutBytes = 0, stderrBytes = 0, truncated = false, timedOut = false, settled = false
        const finish = (callback) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            callback()
        }
        const stop = () => { try { child.kill('SIGKILL') } catch { /* process already exited */ } }
        const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
        child.stdout?.on('data', (chunk) => {
            if (truncated) return
            const remaining = options.maxOutputBytes - stdoutBytes
            if (remaining <= 0) { truncated = true; stop(); return }
            const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
            stdout.push(kept); stdoutBytes += kept.length
            if (kept.length !== chunk.length) { truncated = true; stop() }
        })
        child.stderr?.on('data', (chunk) => {
            const remaining = 64 * 1024 - stderrBytes
            if (remaining <= 0) return
            const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
            stderr.push(kept); stderrBytes += kept.length
        })
        child.on('error', (error) => finish(() => reject(error)))
        child.on('close', (exitCode) => finish(() => {
            if (timedOut) return reject(new Error('git history collection timed out'))
            resolve({
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat(stderr).toString('utf8'),
                exitCode: Number(exitCode ?? 1),
                truncated,
            })
        }))
    })
}

const statNumber = (value) => value === '-'
    ? {value: 0, binary: true}
    : {value: Number(value), binary: false}

export function parseGitNumstatLog(raw, options = {}) {
    const maxFiles = boundedHistoryInteger(options.maxFilesPerCommit, DEFAULTS.maxFilesPerCommit, 2, HARD_CAPS.maxFilesPerCommit)
    const ignoreRules = options.ignoreRules || []
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '')
    const segments = text.split(HEADER_SEPARATOR).slice(1)
    if (options.dropLastIncomplete && segments.length) segments.pop()
    const commits = []
    for (const segment of segments) {
        const firstNul = segment.indexOf('\0')
        if (firstNul < 0) continue
        const header = segment.slice(0, firstNul).replace(/^[\r\n]+/, '')
        const separator = header.indexOf(FIELD_SEPARATOR)
        if (separator < 0) continue
        const hash = header.slice(0, separator), timestamp = Number(header.slice(separator + 1))
        if (!/^[a-f0-9]{40,64}$/i.test(hash) || !Number.isInteger(timestamp) || timestamp < 0) continue
        const tokens = segment.slice(firstNul + 1).split('\0'), files = new Map()
        let fileCount = 0, ignoredFiles = 0, invalidPaths = 0, oversized = false
        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index].replace(/^[\r\n]+/, '')
            const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token)
            if (!match) continue
            let rawPath = match[3], renamedFrom = null
            if (!rawPath) {
                renamedFrom = safeHistoryPath(tokens[index + 1])
                rawPath = tokens[index + 2]
                index += 2
            }
            const path = safeHistoryPath(rawPath)
            if (!path) { invalidPaths++; continue }
            if (isWeavatrixIgnored(path, ignoreRules)) { ignoredFiles++; continue }
            const additions = statNumber(match[1]), deletions = statNumber(match[2])
            fileCount++
            if (fileCount > maxFiles) { oversized = true; files.clear(); continue }
            if (oversized) continue
            const previous = files.get(path)
            files.set(path, {
                file: path,
                additions: (previous?.additions || 0) + additions.value,
                deletions: (previous?.deletions || 0) + deletions.value,
                binary: Boolean(previous?.binary || additions.binary || deletions.binary),
                ...(renamedFrom ? {renamedFrom} : previous?.renamedFrom ? {renamedFrom: previous.renamedFrom} : {}),
            })
        }
        commits.push({
            hash, timestamp, fileCount, ignoredFiles, invalidPaths, oversized,
            files: oversized ? [] : [...files.values()].sort((a, b) => a.file.localeCompare(b.file)),
        })
    }
    return commits
}
