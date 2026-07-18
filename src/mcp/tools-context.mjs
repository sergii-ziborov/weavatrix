import {isStructuralRelation} from '../graph/relations.js'
import {boundedInteger} from '../bounds.js'
import {isSymbol, labelOf} from './graph-context.mjs'
import {toolResult} from './tool-result.mjs'
import {sourceExcerpt} from './tools-source.mjs'

const MAX_LINE_SAMPLES = 5

const fileOf = (g, id) => {
    const node = g.byId.get(String(id))
    return String(node?.source_file || (isSymbol(id) ? String(id).split('#')[0] : id))
}

function aggregateEdges(g, edges, cap, {callsiteFile = null} = {}) {
    const groups = new Map()
    for (const edge of edges || []) {
        if (isStructuralRelation(edge.relation) || edge.barrelProxy === true) continue
        const id = String(edge.id)
        const relation = String(edge.relation || 'references')
        const key = `${id}\0${relation}`
        let group = groups.get(key)
        if (!group) {
            const targetFile = fileOf(g, id)
            group = {
                id, label: labelOf(g, id), relation, count: 0, lines: [],
                file: callsiteFile || targetFile,
                ...(callsiteFile && callsiteFile !== targetFile ? {targetFile} : {}),
            }
            groups.set(key, group)
        }
        group.count++
        if (Number.isInteger(edge.line) && group.lines.length < MAX_LINE_SAMPLES && !group.lines.includes(edge.line)) group.lines.push(edge.line)
        if (edge.typeOnly === true) group.typeOnly = true
        if (edge.compileOnly === true) group.compileOnly = true
    }
    const all = [...groups.values()].sort((left, right) => right.count - left.count
        || left.file.localeCompare(right.file) || left.id.localeCompare(right.id))
    return {total: all.length, shown: all.slice(0, cap), capped: all.length > cap}
}

const sameOrigin = (occurrence, definition) => occurrence.originId === definition.id
    || (occurrence.originFile === definition.file && occurrence.originName === definition.name)

function exactReExportSites(g, definition, cap) {
    const occurrences = Array.isArray(g.reExportOccurrences) ? g.reExportOccurrences : []
    const exposures = new Map()
    if (definition.exported) exposures.set(definition.file, new Set([definition.name]))
    const shown = new Map()
    const add = (occurrence, exported = occurrence.exported) => {
        const key = `${occurrence.file}\0${occurrence.line}\0${exported}\0${occurrence.kind}`
        if (shown.has(key)) return false
        shown.set(key, {
            file: occurrence.file,
            line: occurrence.line,
            kind: occurrence.kind,
            exported,
            imported: occurrence.imported,
            targetFile: occurrence.targetFile,
            typeOnly: occurrence.typeOnly === true,
            ...(occurrence.specifier ? {specifier: occurrence.specifier} : {}),
            ...(occurrence.originFile ? {originFile: occurrence.originFile, originName: occurrence.originName} : {}),
        })
        return true
    }
    for (let pass = 0; pass <= occurrences.length; pass++) {
        let changed = false
        for (const occurrence of occurrences) {
            if (occurrence.kind === 'star') {
                const names = exposures.get(occurrence.targetFile)
                if (!names) continue
                for (const name of names) {
                    if (name === 'default') continue
                    changed = add(occurrence, name) || changed
                    let exported = exposures.get(occurrence.file)
                    if (!exported) exposures.set(occurrence.file, (exported = new Set()))
                    const before = exported.size
                    exported.add(name)
                    changed = exported.size !== before || changed
                }
                continue
            }
            if (!sameOrigin(occurrence, definition)) continue
            changed = add(occurrence) || changed
            if (occurrence.kind !== 'namespace') {
                let exported = exposures.get(occurrence.file)
                if (!exported) exposures.set(occurrence.file, (exported = new Set()))
                const before = exported.size
                exported.add(occurrence.exported)
                changed = exported.size !== before || changed
            }
        }
        if (!changed) break
    }
    const all = [...shown.values()].sort((left, right) => left.file.localeCompare(right.file)
        || left.line - right.line || left.exported.localeCompare(right.exported))
    return {total: all.length, shown: all.slice(0, cap), capped: all.length > cap}
}

function linesForGroups(title, groups) {
    if (!groups.shown.length) return [`${title}: none`]
    const lines = [`${title}: ${groups.total} container(s)${groups.capped ? ` (${groups.shown.length} shown)` : ''}`]
    for (const group of groups.shown) {
        const sites = group.lines.length ? `:${group.lines.join(',')}` : ''
        const destination = group.targetFile ? ` → ${group.targetFile}` : ''
        lines.push(`  ${group.count}× ${group.relation}  ${group.label}  [call site ${group.file}${sites}${destination}]`)
    }
    return lines
}

function textFor(result) {
    if (result.status !== 'OK') return result.text || `Context bundle: ${result.status}`
    const definition = result.definition
    const lines = [
        `Context bundle: ${definition.label}  [${definition.id}]`,
        `Definition: ${definition.file}:${definition.line} (${definition.kind}, ${definition.space} space)`,
        `Evidence: ${result.evidence.state}; ${result.references.occurrences} exact reference occurrence(s) in ${result.references.files} file(s).`,
        ...linesForGroups('Inbound', result.inbound),
        ...linesForGroups('Outbound', result.outbound),
        `Re-export sites: ${result.reExports.total}${result.reExports.capped ? ` (${result.reExports.shown.length} shown)` : ''}`,
    ]
    for (const site of result.reExports.shown) lines.push(`  ${site.file}:${site.line}  ${site.kind} ${site.imported} → ${site.exported}${site.typeOnly ? ' [type]' : ''}`)
    for (const source of result.source) lines.push('', `${source.role} source (${source.file}:${source.startLine}-${source.endLine}):`, source.text)
    return lines.join('\n')
}

export async function tContextBundle(g, args = {}, ctx = {}, inspectSymbol) {
    if (typeof inspectSymbol !== 'function') throw new Error('context_bundle requires inspect_symbol support')
    const maxRelated = boundedInteger(args.max_related, 10, 1, 30)
    const maxReExports = boundedInteger(args.max_reexports, 20, 1, 100)
    const maxSourceFiles = boundedInteger(args.max_source_files, 4, 1, 8)
    const inspected = await inspectSymbol(g, {
        ...args,
        max_containers: Math.min(maxRelated, boundedInteger(args.max_containers, 10, 1, 30)),
        context_lines: boundedInteger(args.context_lines, 4, 0, 12),
    }, ctx)
    const inspection = inspected?.result
    if (!inspection || inspection.status !== 'OK') return inspected
    const definition = {
        ...inspection.definition,
        name: String(g.byId.get(inspection.definition.id)?.label || '').replace(/\(\)$/, ''),
    }
    const inbound = aggregateEdges(g, g.inn.get(definition.id), maxRelated)
    const outbound = aggregateEdges(g, g.out.get(definition.id), maxRelated, {callsiteFile: definition.file})
    const reExports = exactReExportSites(g, definition, maxReExports)
    const source = []
    const append = (role, excerpt) => {
        if (!excerpt || source.length >= maxSourceFiles) return
        if (source.some((item) => item.file === excerpt.file && item.focusLine === excerpt.focusLine)) return
        source.push({role, ...excerpt})
    }
    append('Definition', inspection.source.definition)
    const contextLines = boundedInteger(args.context_lines, 4, 0, 12)
    for (const group of outbound.shown) {
        for (const line of group.lines) append('Outbound call site', sourceExcerpt(ctx.repoRoot, group.file, line, contextLines))
    }
    for (const group of inbound.shown) {
        for (const line of group.lines) append('Inbound call site', sourceExcerpt(ctx.repoRoot, group.file, line, contextLines))
    }
    for (const excerpt of inspection.source.callers || []) {
        append('Reference', excerpt)
    }
    const result = {
        status: 'OK', definition, evidence: inspection.evidence,
        references: {
            occurrences: inspection.exact.occurrences,
            files: inspection.exact.files,
            containers: inspection.exact.containers,
            capped: inspection.exact.capped,
        },
        inbound, outbound, reExports, source,
    }
    return toolResult(textFor(result), result, {
        warnings: inspected.warnings,
        completeness: {
            status: inspection.evidence.state === 'EXACT' && !inspection.exact.capped && !inbound.capped && !outbound.capped && !reExports.capped ? 'complete' : 'bounded',
            relatedLimit: maxRelated,
            reExportLimit: maxReExports,
            sourceFileLimit: maxSourceFiles,
        },
    })
}
