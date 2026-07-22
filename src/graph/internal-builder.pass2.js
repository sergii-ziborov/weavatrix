import {readFileSync} from 'node:fs'
import {extname} from 'node:path'
import {Parser, EXT_LANG, FAMILY, LANGS} from './internal-builder.langs.js'
import {addJavaReferences} from './internal-builder.java.js'
import {resolveJsBarrels} from './internal-builder.barrels.js'
import {createPass2Resolution} from './builder/pass2-resolution.js'
import {createGoReceiverResolution} from './builder/go-receiver-resolution.js'

export function runInternalGraphPass2({
    files, rel, langs, caps, field, links, nodeById, perFileSymbols, symByFileName,
    symIdsByFileName, importedLocals, jsExports, resolvers,
}) {
    const resolution = createPass2Resolution({symIdsByFileName, nodeById, importedLocals, symByFileName})
    const {dirSymbols, resolveNamedSymbol, resolveCall, resolveJavaType, resolveRustMethod} = resolution
    const {resolveRustPath, resolveRustCratePath} = resolvers || {}
    const {resolveNamespaceMember, reExportOccurrences} = resolveJsBarrels({
        jsExports, importedLocals, links,
        resolveSymbol: (file, name, typeOnly) => resolveNamedSymbol(file, name, typeOnly ? 'type' : 'value'),
    })
    const enclosing = (file, line) => {
        let best = null
        for (const symbol of perFileSymbols.get(file) || []) {
            if (line < symbol.start || line > symbol.end) continue
            if (!best || symbol.start > best.start || (symbol.start === best.start && symbol.end < best.end)) best = symbol
        }
        return best
    }
    const goReceivers = createGoReceiverResolution({resolution, nodeById, importedLocals})
    for (const absolute of files) {
        const file = rel(absolute), grammar = EXT_LANG[extname(absolute)]
        if (!grammar) continue
        const lang = LANGS[FAMILY[grammar]]
        if (!lang || lang.isWeb || !langs[grammar]) continue
        let code
        try { code = readFileSync(absolute, 'utf8') } catch { continue }
        const parser = new Parser()
        parser.setLanguage(langs[grammar])
        let tree
        try { tree = parser.parse(code) } catch { continue }
        if (!lang.customCalls) for (const capture of caps(grammar, lang.calls, tree.rootNode)) {
            const caller = enclosing(file, capture.node.startPosition.row + 1)
            if (!caller) continue
            const target = resolveCall(capture.node.text, file)
            if (target && target !== caller.id) links.push({source: caller.id, target, relation: 'calls', confidence: 'INFERRED', line: capture.node.startPosition.row + 1})
        }
        if (typeof lang.pass2 === 'function') try {
            lang.pass2({
                grammar, tree, fileRel: file, code, caps, field, enclosing, links, nodeById,
                perFileSymbols, symByFileName, symIdsByFileName, importedLocals, resolveCall, resolveJavaType,
                dirSymbols, resolveNamedSymbol, resolveRustMethod, resolveRustPath, resolveRustCratePath,
            })
        } catch { /* one language-specific resolver never sinks the graph */ }
        if (lang.selectorCall) for (const capture of caps(grammar, lang.selectorCall, tree.rootNode)) {
            const selector = capture.node, operand = field(selector, 'operand'), member = field(selector, 'field')
            if (!operand || !member) continue
            const caller = enclosing(file, selector.startPosition.row + 1)
            if (!caller) continue
            const bindings = goReceivers.receiverBindings(selector, file)
            const imported = operand.type === 'identifier' && !bindings.has(operand.text)
                ? importedLocals.get(file)?.get(operand.text) : null
            let target = imported?.targetDir ? dirSymbols.get(imported.targetDir)?.get(member.text) : null
            let resolved = !!target
            if (!target) {
                let receiver = null
                if (operand.type === 'identifier') receiver = bindings.get(operand.text) || null
                else if (operand.type === 'selector_expression') {
                    const base = field(operand, 'operand')
                    const baseType = base?.type === 'identifier' ? bindings.get(base.text) : null
                    receiver = goReceivers.fieldType(baseType, field(operand, 'field')?.text)
                }
                target = goReceivers.exactMethod(receiver, member.text)
                resolved = !!target
                if (!target && !receiver) target = goReceivers.uniqueMethod(goReceivers.dirOf(file), member.text)
            }
            if (target && target !== caller.id) links.push({
                source: caller.id, target, relation: 'calls', confidence: 'INFERRED',
                ...(resolved ? {provenance: 'RESOLVED'} : {}), line: selector.startPosition.row + 1,
            })
        }
        for (const heritageSpec of lang.heritage || []) {
            const query = typeof heritageSpec === 'string' ? heritageSpec : heritageSpec.query
            const relation = typeof heritageSpec === 'string' ? 'inherits' : (heritageSpec.relation || 'inherits')
            for (const capture of caps(grammar, query, tree.rootNode)) {
                const owner = enclosing(file, capture.node.startPosition.row + 1)
                if (!owner) continue
                const target = FAMILY[grammar] === 'java' ? resolveJavaType(capture.node.text, file) : resolveCall(capture.node.text, file)
                if (target && target !== owner.id) links.push({source: owner.id, target, relation, confidence: 'INFERRED'})
            }
        }
        if (FAMILY[grammar] === 'js') addJavaScriptReferences({
            grammar, tree, file, caps, field, importedLocals, resolveNamespaceMember,
            resolveNamedSymbol, enclosing, links,
        })
        if (FAMILY[grammar] === 'go') addGoReferences({
            grammar, tree, file, caps, field, importedLocals, dirSymbols, enclosing, links,
        })
        if (FAMILY[grammar] === 'java') addJavaReferences({grammar, tree, fileRel: file, caps, resolveJavaType, enclosing, links})
        tree.delete()
    }
    return {reExportOccurrences}
}

function addJavaScriptReferences({grammar, tree, file, caps, field, importedLocals, resolveNamespaceMember, resolveNamedSymbol, enclosing, links}) {
    for (const capture of caps(grammar, `(call_expression function: (member_expression) @memberCall)`, tree.rootNode)) {
        const object = field(capture.node, 'object'), property = field(capture.node, 'property')
        if (!object || object.type !== 'identifier' || !property) continue
        const imported = importedLocals.get(file)?.get(object.text)
        if (!imported || !['*', 'default'].includes(imported.imported) || imported.typeOnly) continue
        const origin = resolveNamespaceMember(file, imported, property.text, 'call')
        if (origin.status !== 'resolved') continue
        const target = resolveNamedSymbol(origin.origin.file, origin.origin.name, 'value')
        const caller = enclosing(file, capture.node.startPosition.row + 1)
        if (target && caller && target !== caller.id) links.push({source: caller.id, target, relation: 'calls', confidence: 'INFERRED', line: capture.node.startPosition.row + 1})
    }
    for (const capture of caps(grammar, `[(jsx_opening_element name: (_) @jsx) (jsx_self_closing_element name: (_) @jsx)]`, tree.rootNode)) {
        const parts = capture.node.text.split('.'), localName = parts[0]
        if (parts.length === 1 && !/^[A-Z_$]/.test(localName)) continue
        const imported = importedLocals.get(file)?.get(localName)
        if (!imported?.targetFile || imported.typeOnly) continue
        let targetFile = imported.originFile || imported.targetFile
        let importedName = imported.originName || imported.imported
        if (imported.imported === '*' && parts.length > 1) {
            const origin = resolveNamespaceMember(file, imported, parts.at(-1), 'jsx')
            if (origin.status === 'resolved') { targetFile = origin.origin.file; importedName = origin.origin.name }
        }
        const target = resolveNamedSymbol(targetFile, importedName, 'value') || resolveNamedSymbol(targetFile, localName, 'value')
        if (!target) continue
        const owner = enclosing(file, capture.node.startPosition.row + 1)
        links.push({source: owner?.id || file, target, relation: 'references', confidence: 'INFERRED', usage: 'jsx', line: capture.node.startPosition.row + 1})
    }
    if (grammar === 'javascript') return
    for (const capture of caps(grammar, `(type_identifier) @typeRef`, tree.rootNode)) {
        const name = capture.node.text, imported = importedLocals.get(file)?.get(name)
        const targetFile = imported?.originFile || imported?.targetFile || file
        const targetName = imported?.originName || imported?.imported || name
        const target = resolveNamedSymbol(targetFile, targetName, 'type')
        if (!target || String(target).startsWith(`${file}#${name}@${capture.node.startPosition.row + 1}`)) continue
        const source = enclosing(file, capture.node.startPosition.row + 1)?.id || file
        if (source !== target) links.push({source, target, relation: 'references', confidence: 'EXTRACTED', provenance: 'RESOLVED', typeOnly: true, line: capture.node.startPosition.row + 1, usage: 'type'})
    }
}

function addGoReferences({grammar, tree, file, caps, field, importedLocals, dirSymbols, enclosing, links}) {
    const seen = new Set()
    const emit = (source, target) => {
        const key = `${source}>${target}`
        if (!target || target === source || seen.has(key)) return
        seen.add(key); links.push({source, target, relation: 'references', confidence: 'INFERRED'})
    }
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '', symbols = dirSymbols.get(dir)
    for (const capture of caps(grammar, `[(identifier) (type_identifier)] @id`, tree.rootNode)) {
        const target = symbols?.get(capture.node.text)
        if (!target || target.slice(0, target.indexOf('#')) === file) continue
        emit(enclosing(file, capture.node.startPosition.row + 1)?.id || file, target)
    }
    for (const capture of caps(grammar, `(selector_expression) @sel`, tree.rootNode)) {
        const selector = capture.node, operand = field(selector, 'operand'), member = field(selector, 'field')
        if (!operand || operand.type !== 'identifier' || !member) continue
        const imported = importedLocals.get(file)?.get(operand.text)
        const target = imported?.targetDir && dirSymbols.get(imported.targetDir)?.get(member.text)
        if (target) emit(enclosing(file, selector.startPosition.row + 1)?.id || file, target)
    }
}
