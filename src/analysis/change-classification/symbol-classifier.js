import {hasPathClass} from '../../path-classification.js'
import {bareGraphLabel, CHANGE_CLASS_RANK, changeLineNumber, normalizeChangePath} from './options.js'

export function indexChangeGraph(graph, limits) {
    const byFile = new Map()
    for (const node of graph?.nodes || []) {
        const file = normalizeChangePath(node?.source_file || (!String(node?.id || '').includes('#') ? node?.id : ''))
        if (!file) continue
        if (!byFile.has(file)) byFile.set(file, {path: file, fileNodeId: null, symbols: []})
        const record = byFile.get(file)
        if (!String(node.id).includes('#')) record.fileNodeId = String(node.id)
        else if (record.symbols.length < limits.maxSymbolsPerFile) {
            const start = changeLineNumber(node.source_location) || changeLineNumber(node.id)
            if (!start) continue
            record.symbols.push({
                id: String(node.id), label: String(node.label || node.id), start,
                end: changeLineNumber(node.source_end), exported: node.exported === true,
                symbolKind: node.symbol_kind || null,
            })
        }
    }
    for (const record of byFile.values()) {
        record.symbols.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
        for (let index = 0; index < record.symbols.length; index++) {
            const symbol = record.symbols[index]
            if (!symbol.end || symbol.end < symbol.start) {
                const next = record.symbols[index + 1]?.start
                symbol.end = next ? Math.max(symbol.start, next - 1) : symbol.start + 400
            }
            symbol.end = Math.min(symbol.end, symbol.start + 2_000)
        }
    }
    return byFile
}

const isMetadataLine = (text) => {
    const value = String(text || '').trim()
    return !value || /^(?:\/\/|\/\*|\*|\*\/|#(?!include\b)|<!--|-->|"""|''')/.test(value)
}

function signatureText(text, symbol) {
    const value = String(text || '').trim(), name = bareGraphLabel(symbol.label)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hasName = name && new RegExp(`\\b${escaped}\\b`, 'i').test(value)
    return hasName && /\b(?:export|default|declare|abstract|async|function|class|interface|type|enum|const|let|var|def|func|fn|struct|trait|impl|public|private|protected|static)\b/.test(value)
}

function signaturePosition(change, symbol) {
    const candidates = change.kind === 'removed' ? [change.mappedNewLine, change.oldLine] : [change.newLine]
    if (candidates.some((line) => line === symbol.start)) return true
    if (!candidates.some((line) => Number.isFinite(line) && line > symbol.start && line <= symbol.start + 4)) return false
    const value = String(change.text || '').trim()
    if (/^(?:return|throw|yield|if|for|while|switch|match|const|let|var|this\.|self\.|[A-Za-z_$][\w$]*\s*=)/.test(value)) return false
    return /^(?:[A-Za-z_$][\w$]*\??\s*:\s*[^;]+[,)]?|[A-Za-z_$][\w$<>,.?\[\] :*&]+\s+[A-Za-z_$][\w$]*\s*[,)]|[),:<>{}\[\]|&?]+)$/.test(value)
}

const moduleSignatureText = (text) => /^\s*(?:import\b|export\s+(?:\*|\{)|(?:const|let|var)\s+\w+\s*=\s*require\b|using\b|package\b|#include\b|mod\b|pub\s+use\b)/.test(String(text || ''))

function chooseSymbol(record, change) {
    if (!record?.symbols?.length) return null
    const lines = change.kind === 'removed'
        ? [...new Set([change.mappedNewLine, change.oldLine].filter((line) => Number.isFinite(line) && line > 0))]
        : [change.newLine]
    const candidates = []
    for (const symbol of record.symbols) {
        if (!lines.some((line) => line >= symbol.start && line <= symbol.end)) continue
        const label = bareGraphLabel(symbol.label)
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        candidates.push({symbol, mentions: label && new RegExp(`\\b${escaped}\\b`).test(change.text), span: symbol.end - symbol.start})
    }
    return candidates.sort((a, b) => Number(b.mentions) - Number(a.mentions) || a.span - b.span || a.symbol.id.localeCompare(b.symbol.id))[0]?.symbol || null
}

const strongest = (classes) => [...classes]
    .sort((a, b) => (CHANGE_CLASS_RANK[b] ?? 5) - (CHANGE_CLASS_RANK[a] ?? 5) || a.localeCompare(b))[0] || 'metadata-only'

function symbolChanges(parsed, record, includeAddedSeeds) {
    const grouped = new Map(), unmapped = []
    for (const change of [...parsed.additions, ...parsed.removals]) {
        const symbol = chooseSymbol(record, change)
        if (!symbol) { unmapped.push(change); continue }
        if (!grouped.has(symbol.id)) grouped.set(symbol.id, {symbol, additions: [], removals: []})
        grouped.get(symbol.id)[change.kind === 'added' ? 'additions' : 'removals'].push(change)
    }
    const symbols = [], seedIds = []
    for (const group of [...grouped.values()].sort((a, b) => a.symbol.start - b.symbol.start || a.symbol.id.localeCompare(b.symbol.id))) {
        const addedCode = group.additions.filter((change) => !isMetadataLine(change.text))
        const removedCode = group.removals.filter((change) => !isMetadataLine(change.text))
        const addedDeclaration = addedCode.some((change) => signaturePosition(change, group.symbol) || signatureText(change.text, group.symbol))
        const removedDeclaration = removedCode.some((change) => signaturePosition(change, group.symbol) || signatureText(change.text, group.symbol))
        let classification
        if (parsed.newFile || (addedDeclaration && !removedCode.length)) classification = 'added'
        else if (parsed.deletedFile || (removedDeclaration && !addedCode.length)) classification = 'removed'
        else if (addedDeclaration || removedDeclaration) classification = 'signature-changed'
        else if (addedCode.length || removedCode.length) classification = 'body-changed'
        else classification = 'metadata-only'
        const reasons = {
            added: 'new declaration; existing callers cannot depend on it yet',
            removed: 'declaration removed; existing callers may break',
            'signature-changed': 'declaration/signature line changed',
            'body-changed': 'executable lines changed inside the symbol body',
            'metadata-only': 'only comment/blank lines changed in this symbol',
        }
        const symbolSeeds = []
        if (classification === 'added') { if (includeAddedSeeds) symbolSeeds.push(group.symbol.id) }
        else if (classification !== 'metadata-only') {
            symbolSeeds.push(group.symbol.id)
            if (['removed', 'signature-changed'].includes(classification) && group.symbol.exported && record?.fileNodeId) symbolSeeds.push(record.fileNodeId)
        }
        seedIds.push(...symbolSeeds)
        symbols.push({
            id: group.symbol.id, label: group.symbol.label, start: group.symbol.start, end: group.symbol.end,
            exported: group.symbol.exported, classification, reason: reasons[classification],
            addedLines: group.additions.map((change) => change.newLine).filter(Boolean),
            removedLines: group.removals.map((change) => change.oldLine).filter(Boolean),
            seedIds: [...new Set(symbolSeeds)].sort(),
        })
    }
    return {symbols, seedIds, unmapped}
}

export function analyzeParsedFile(parsed, indexed, {includeAddedSeeds}) {
    const path = parsed.newPath || parsed.oldPath || '(unknown)'
    const record = indexed.get(parsed.newPath) || indexed.get(parsed.oldPath) || null
    const grouped = symbolChanges(parsed, record, includeAddedSeeds)
    const unmappedCode = grouped.unmapped.filter((change) => !isMetadataLine(change.text))
    const unmappedMetadata = grouped.unmapped.length > 0 && !unmappedCode.length
    let classification, reason
    if (parsed.binary) { classification = 'unknown'; reason = 'binary diff has no line-level evidence' }
    else if (parsed.deletedFile) { classification = 'removed'; reason = 'file removed' }
    else if (parsed.renamed) { classification = 'signature-changed'; reason = 'file rename changes module identity' }
    else if (parsed.newFile) { classification = 'added'; reason = 'new file; no existing dependent can target it yet' }
    else if (unmappedCode.some((change) => moduleSignatureText(change.text))) { classification = 'signature-changed'; reason = 'module import/export surface changed outside a mapped symbol' }
    else if (unmappedCode.length) { classification = 'unknown'; reason = 'executable diff lines could not be mapped to a graph symbol' }
    else if (grouped.symbols.length) {
        classification = strongest(grouped.symbols.map((symbol) => symbol.classification))
        reason = grouped.symbols.length === 1 ? grouped.symbols[0].reason : `${grouped.symbols.length} mapped symbols; strongest change is ${classification}`
    } else if (unmappedMetadata || parsed.hunks.length || parsed.additions.length || parsed.removals.length) {
        classification = 'metadata-only'; reason = 'only comment/blank metadata changed outside symbols'
    } else { classification = 'metadata-only'; reason = 'file metadata changed without textual hunks' }

    const seedIds = grouped.seedIds
    if (parsed.binary || parsed.deletedFile || parsed.renamed || classification === 'unknown') {
        if (record?.fileNodeId) seedIds.push(record.fileNodeId)
        if (parsed.binary || parsed.deletedFile || classification === 'unknown') seedIds.push(...(record?.symbols || []).map((symbol) => symbol.id))
    } else if (classification === 'signature-changed' && !grouped.symbols.length && record?.fileNodeId) seedIds.push(record.fileNodeId)
    else if (classification === 'added' && includeAddedSeeds) {
        if (record?.fileNodeId) seedIds.push(record.fileNodeId)
        seedIds.push(...grouped.symbols.map((symbol) => symbol.id))
    }
    return {
        path, oldPath: parsed.oldPath, newPath: parsed.newPath, classification, reason,
        binary: parsed.binary, renamed: parsed.renamed,
        addedLines: parsed.additions.length, removedLines: parsed.removals.length,
        symbols: grouped.symbols, seedIds: [...new Set(seedIds)].sort(),
    }
}

export function unknownChangedFile(path, indexed, reason) {
    const normalized = normalizeChangePath(path), record = indexed.get(normalized)
    return {
        path: normalized, oldPath: normalized, newPath: normalized, classification: 'unknown', reason,
        binary: false, renamed: false, addedLines: 0, removedLines: 0, symbols: [],
        seedIds: [record?.fileNodeId, ...(record?.symbols || []).map((symbol) => symbol.id)].filter(Boolean).sort(),
    }
}

export function classifyTestSurface(file, pathClassifier) {
    const explanation = pathClassifier.explain(file.path)
    if (!hasPathClass(explanation, 'test', 'e2e')) return file
    const surface = explanation.classes.includes('e2e') ? 'e2e' : 'test'
    return {
        ...file, classification: 'test-only', changeClassification: file.classification,
        reason: `${surface} path; excluded from the product blast-radius seed set`,
        pathClasses: explanation.classes, seedIds: [],
    }
}
