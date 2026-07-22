// Occurrence-selective bulk replace as an edit-plan producer. Two-stage contract modeled
// on the strongest competitor mechanics, upgraded with true cross-file atomicity:
// stage 1 (no selection) previews every occurrence with a stable id; stage 2 plans only
// the selected occurrence_ids (or all, guarded by expected_count). The emitted
// weavatrix.edit-plan.v1 carries LEXICAL_EXACT provenance — these edits are proven by
// byte-exact before-text, not by parser or language-server evidence, and the applier
// re-verifies that before-text under the file hash at apply time.
// The scanned universe is the graph's indexed file list: honest and bounded — files the
// graph does not know are reported as a limitation, never silently skipped.

import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'

const MAX_PATTERN_LENGTH = 512
const MAX_FILES_SCANNED = 2000
const MAX_MATCHES_PER_FILE = 500
const MAX_TOTAL_MATCHES = 5000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const ALLOWED_FLAGS = /^[imsu]*$/

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function graphFiles(rawGraph) {
    const files = new Set()
    for (const node of rawGraph.nodes || []) {
        const file = String(node?.source_file || '')
        if (file) files.add(file)
    }
    return [...files].sort()
}

// $1..$9, $& and $$ expansion against the actual match array — never by re-running the
// pattern on the matched substring, which silently breaks lookarounds and anchors
// Full JS String.replace substitution semantics against the actual match array:
// $$ -> $, $& -> whole match, $<name> -> named group, $n / $nn -> numbered group
// (two-digit preferred when that group exists, else one digit + literal trailing digit).
// A reference to a non-existent group is left literal, exactly as native replace does.
const expandReplacement = (template, match) => {
    const groupCount = match.length - 1
    const named = match.groups || {}
    return template.replace(/\$(\$|&|<([^>]*)>|\d{1,2})/g, (token, body, namedRef) => {
        if (body === '$') return '$'
        if (body === '&') return match[0]
        if (namedRef !== undefined) return Object.hasOwn(named, namedRef) ? (named[namedRef] ?? '') : token
        if (body.length === 2) {
            const twoDigit = Number(body)
            if (twoDigit >= 1 && twoDigit <= groupCount) return match[twoDigit] ?? ''
        }
        const oneDigit = Number(body[0])
        if (oneDigit >= 1 && oneDigit <= groupCount) return (match[oneDigit] ?? '') + (body.length === 2 ? body[1] : '')
        return token
    })
}

function scanFile(file, content, regex, replacement, literal) {
    const occurrences = []
    // incremental line tracking: matches arrive in ascending offset order, so counting
    // newlines between offsets keeps the whole scan linear in file size
    let cursorOffset = 0
    let cursorLine = 1
    let cursorLineStart = 0
    const lineCharOf = (offset) => {
        for (let index = cursorOffset; index < offset; index += 1) {
            if (content.charCodeAt(index) === 10) {
                cursorLine += 1
                cursorLineStart = index + 1
            }
        }
        cursorOffset = Math.max(cursorOffset, offset)
        return {line: cursorLine, character: offset - cursorLineStart}
    }
    regex.lastIndex = 0
    let zeroWidth = 0
    let match
    while ((match = regex.exec(content)) !== null) {
        if (match[0] === '') {
            zeroWidth += 1
            // advance by a full code point so a zero-width match at a surrogate pair
            // (u-flag) cannot split it and loop forever
            const next = content.codePointAt(regex.lastIndex)
            regex.lastIndex += next !== undefined && next > 0xffff ? 2 : 1
            continue
        }
        const start = lineCharOf(match.index)
        const endOffset = match.index + match[0].length
        const end = lineCharOf(endOffset)
        const after = literal ? replacement : expandReplacement(replacement, match)
        occurrences.push({
            id: `${file}@${start.line}:${start.character}`,
            file,
            startLine: start.line,
            startChar: start.character,
            endLine: end.line,
            endChar: end.character,
            before: match[0],
            after,
            excerpt: content.slice(Math.max(0, match.index - 30), endOffset + 30).trim().slice(0, 160),
        })
        if (occurrences.length >= MAX_MATCHES_PER_FILE) break
    }
    return {occurrences, zeroWidth}
}

// Stage 1: preview {status:'PREVIEW', occurrences, total, capped}. Stage 2 (with
// occurrence_ids or expected_count): {status:'PLANNED', plan}. Fail-closed statuses for
// invalid patterns, unknown ids, count mismatches, and no matches.
export function buildBulkReplacePlan({
    repoRoot,
    rawGraph,
    pattern,
    replacement,
    literal = true,
    flags = '',
    path_prefix = '',
    occurrence_ids = null,
    expected_count = null,
} = {}) {
    if (!repoRoot || !rawGraph) throw new Error('bulk replace requires repoRoot and rawGraph')
    if (typeof pattern !== 'string' || !pattern.length) return {status: 'INVALID_PATTERN', reason: 'pattern must be a non-empty string'}
    if (pattern.length > MAX_PATTERN_LENGTH) return {status: 'INVALID_PATTERN', reason: `pattern exceeds ${MAX_PATTERN_LENGTH} characters`}
    if (typeof replacement !== 'string') return {status: 'INVALID_PATTERN', reason: 'replacement must be a string'}
    if (!ALLOWED_FLAGS.test(flags)) return {status: 'INVALID_PATTERN', reason: 'flags may only contain i, m, s, u'}
    let regex
    try {
        regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, `g${flags}`)
    } catch (error) {
        return {status: 'INVALID_PATTERN', reason: error.message}
    }

    // path_prefix is a directory prefix, segment-anchored so 'src' never matches
    // 'src-evil/…'; it may also name one exact file.
    const dirPrefix = path_prefix && !path_prefix.endsWith('/') ? `${path_prefix}/` : path_prefix
    const files = graphFiles(rawGraph).filter((file) => !path_prefix || file === path_prefix || file.startsWith(dirPrefix))
    const warnings = []
    const skipped = []
    const occurrences = []
    let scanned = 0
    let capped = false
    let zeroWidthTotal = 0
    for (const file of files) {
        if (scanned >= MAX_FILES_SCANNED || occurrences.length >= MAX_TOTAL_MATCHES) {
            capped = true
            break
        }
        scanned += 1
        let buffer
        try {
            buffer = readFileSync(resolve(repoRoot, file))
        } catch {
            // a graph-indexed file that vanished/became unreadable since indexing is
            // surfaced, not silently skipped
            skipped.push({file, reason: 'file could not be read (deleted or unreadable since indexing)'})
            continue
        }
        if (buffer.length > MAX_FILE_BYTES) {
            skipped.push({file, reason: 'file exceeds the scan size limit'})
            continue
        }
        const content = buffer.toString('utf8')
        if (!Buffer.from(content, 'utf8').equals(buffer)) {
            skipped.push({file, reason: 'not valid UTF-8 text'})
            continue
        }
        const found = scanFile(file, content, regex, replacement, literal)
        zeroWidthTotal += found.zeroWidth
        if (!found.occurrences.length) continue
        if (found.occurrences.length >= MAX_MATCHES_PER_FILE) capped = true
        for (const occurrence of found.occurrences) {
            occurrence.sha256 = sha256Hex(buffer)
            occurrences.push(occurrence)
        }
    }
    if (capped) warnings.push('SCAN_CAPPED')
    if (skipped.length) warnings.push('FILES_SKIPPED')
    warnings.push('INDEXED_UNIVERSE_ONLY')

    if (!occurrences.length) {
        if (zeroWidthTotal) {
            return {status: 'ZERO_WIDTH_UNSUPPORTED', reason: `the pattern matched ${zeroWidthTotal} zero-width position(s) but bulk_replace only replaces non-empty matches; use an insert operation for insertion points`, scannedFiles: scanned, warnings, skipped}
        }
        return {status: 'NO_MATCHES', reason: 'no occurrence of the pattern exists in the indexed universe', scannedFiles: scanned, warnings, skipped}
    }

    const selecting = Array.isArray(occurrence_ids)
    if (!selecting && expected_count === null) {
        return {
            status: 'PREVIEW',
            total: occurrences.length,
            scannedFiles: scanned,
            occurrences: occurrences.map(({sha256, ...rest}) => rest),
            warnings,
            skipped,
            next: 'call again with occurrence_ids=[...] to plan a selection, or expected_count=<total> to plan everything',
        }
    }
    let chosen = occurrences
    if (selecting) {
        const wanted = new Set(occurrence_ids.map(String))
        if (!wanted.size) return {status: 'NO_SELECTION', reason: 'occurrence_ids was empty; select at least one occurrence, or use expected_count to plan all', warnings}
        chosen = occurrences.filter((occurrence) => wanted.has(occurrence.id))
        if (chosen.length !== wanted.size) {
            const known = new Set(chosen.map((occurrence) => occurrence.id))
            const unknown = [...wanted].filter((id) => !known.has(id))
            return {status: 'UNKNOWN_OCCURRENCES', reason: 'some occurrence_ids do not match the current scan; re-preview and reselect', unknown, warnings}
        }
    }
    if (expected_count !== null && chosen.length !== expected_count) {
        return {
            status: 'COUNT_MISMATCH',
            reason: `expected ${expected_count} occurrence(s) but the scan found ${chosen.length}; the repository changed or the estimate was wrong — re-preview`,
            total: chosen.length,
            warnings,
        }
    }

    const byFile = new Map()
    for (const occurrence of chosen) {
        if (!byFile.has(occurrence.file)) byFile.set(occurrence.file, {path: occurrence.file, sha256: occurrence.sha256, edits: []})
        byFile.get(occurrence.file).edits.push({
            startLine: occurrence.startLine,
            startChar: occurrence.startChar,
            endLine: occurrence.endLine,
            endChar: occurrence.endChar,
            before: occurrence.before,
            after: occurrence.after,
            provenance: 'LEXICAL_EXACT',
        })
    }
    return {
        status: 'PLANNED',
        total: chosen.length,
        files: byFile.size,
        plan: {
            schemaVersion: 'weavatrix.edit-plan.v1',
            operation: 'bulk_replace',
            createdAt: new Date().toISOString(),
            graphRevision: rawGraph.graphRevision || null,
            completeness: capped || skipped.length ? 'PARTIAL' : 'COMPLETE',
            files: [...byFile.values()],
            uncertainReferences: [],
            notModified: skipped.map(({file, reason}) => ({path: file, reason})),
            warnings,
            followUp: 'apply with weavatrix-refactor apply_edit_plan (preview -> confirm) or your editor, then run verified_change phase=verify',
        },
    }
}
