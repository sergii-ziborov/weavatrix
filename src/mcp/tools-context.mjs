import {isStructuralRelation} from '../graph/relations.js'
import {boundedInteger} from '../bounds.js'
import {isSymbol, labelOf} from './graph-context.mjs'
import {toolResult} from './tool-result.mjs'
import {sourceExcerpt} from './tools-source.mjs'
import {createPathClassifier, hasPathClass} from '../path-classification.js'

const MAX_LINE_SAMPLES = 5
const CONTEXT_NON_PRODUCT = Object.freeze(['test', 'e2e', 'generated', 'vendored', 'mock', 'story', 'docs', 'benchmark', 'temp'])

const fileOf = (g, id) => {
    const node = g.byId.get(String(id))
    return String(node?.source_file || (isSymbol(id) ? String(id).split('#')[0] : id))
}

function aggregateEdges(g, edges, cap, {
    callsiteFile = null, classifier = null, includeClassified = true, productionFirst = false,
} = {}) {
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
    const all = [...groups.values()]
    if (classifier) for (const group of all) {
        const info = classifier.explain(group.file, {content: ''})
        const classes = CONTEXT_NON_PRODUCT.filter((name) => hasPathClass(info, name))
        group.classified = classes.length > 0 || info?.excluded === true
        if (classes.length) group.pathClasses = classes
    }
    const eligible = includeClassified ? all : all.filter((group) => !group.classified)
    eligible.sort((left, right) => (productionFirst ? Number(left.classified) - Number(right.classified) : 0)
        || right.count - left.count || left.file.localeCompare(right.file) || left.id.localeCompare(right.id))
    return {
        total: eligible.length,
        available: all.length,
        suppressed: all.length - eligible.length,
        shown: eligible.slice(0, cap),
        capped: eligible.length > cap,
    }
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
    const suppression = groups.suppressed ? `; ${groups.suppressed} classified container(s) suppressed` : ''
    if (!groups.shown.length) return [`${title}: none${suppression}`]
    const lines = [`${title}: ${groups.total} container(s)${groups.capped ? ` (${groups.shown.length} shown)` : ''}${suppression}`]
    for (const group of groups.shown) {
        const sites = group.lines.length ? `:${group.lines.join(',')}` : ''
        const destination = group.targetFile ? ` → ${group.targetFile}` : ''
        const classified = group.classified ? ` [classified${group.pathClasses?.length ? `:${group.pathClasses.join('+')}` : ''}]` : ''
        lines.push(`  ${group.count}× ${group.relation}  ${group.label}  [call site ${group.file}${sites}${destination}]${classified}`)
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
    const classifier = createPathClassifier(ctx.repoRoot || null)
    const includeClassified = args.include_classified === true
    const inbound = aggregateEdges(g, g.inn.get(definition.id), maxRelated, {
        classifier, includeClassified, productionFirst: true,
    })
    const outbound = aggregateEdges(g, g.out.get(definition.id), maxRelated, {callsiteFile: definition.file})
    const reExports = exactReExportSites(g, definition, maxReExports)
    const source = []
    const overlaps = (left, right) => left.file === right.file
        && left.startLine <= right.endLine && right.startLine <= left.endLine
    const append = (role, excerpt) => {
        if (!excerpt || source.length >= maxSourceFiles) return
        if (source.some((item) => overlaps(item, excerpt))) return
        source.push({role, ...excerpt})
    }
    append('Definition', inspection.source.definition)
    const contextLines = boundedInteger(args.context_lines, 4, 0, 12)
    const excerptCandidates = []
    const groupExcerpts = (groups, role) => {
        const primary = []
        const secondary = []
        for (const group of groups.shown) for (let index = 0; index < group.lines.length; index++) {
            const candidate = {role, excerpt: sourceExcerpt(ctx.repoRoot, group.file, group.lines[index], contextLines)}
            ;(index === 0 ? primary : secondary).push(candidate)
        }
        return [...primary, ...secondary]
    }
    const outboundExcerpts = groupExcerpts(outbound, 'Outbound call site')
    const inboundExcerpts = groupExcerpts(inbound, 'Inbound call site')
    for (let index = 0; index < Math.max(outboundExcerpts.length, inboundExcerpts.length); index++) {
        if (outboundExcerpts[index]) excerptCandidates.push(outboundExcerpts[index])
        if (inboundExcerpts[index]) excerptCandidates.push(inboundExcerpts[index])
    }
    for (const excerpt of inspection.source.callers || []) excerptCandidates.push({role: 'Reference', excerpt})
    const deferred = []
    for (const candidate of excerptCandidates) {
        const knownFile = source.some((item) => item.file === candidate.excerpt?.file)
        if (knownFile && candidate.role !== 'Outbound call site') deferred.push(candidate)
        else append(candidate.role, candidate.excerpt)
    }
    for (const candidate of deferred) append(candidate.role, candidate.excerpt)
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
