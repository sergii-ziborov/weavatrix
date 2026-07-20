import {isWeavatrixIgnored} from '../../path-ignore.js'
import {
    boundedHistoryInteger,
    GIT_HISTORY_DEFAULTS as DEFAULTS,
    GIT_HISTORY_HARD_CAPS as HARD_CAPS,
    safeHistoryPath,
} from './options.js'

const HEADER_SEPARATOR = '\x1e'
const FIELD_SEPARATOR = '\x1f'

// git subprocess execution (sync runGit + streaming boundedGitCommand) lives in ../../git-exec.js.

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
