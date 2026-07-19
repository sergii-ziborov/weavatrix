import {goTypeName} from './lang-go.js'

const dirOf = (file) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''

export function createGoReceiverResolution({resolution, nodeById, importedLocals}) {
    const {dirSymbols, dirMethods, dirMethodsByName, dirTypes, resolveCall} = resolution
    const typeRef = (rawType, contextFile, fallbackDir = dirOf(contextFile)) => {
        const raw = String(rawType || '').trim()
        if (!raw) return null
        const dot = raw.indexOf('.')
        if (dot > 0) {
            const imported = importedLocals.get(contextFile)?.get(raw.slice(0, dot))
            return imported?.targetDir ? {dir: imported.targetDir, name: raw.slice(dot + 1)} : null
        }
        return {dir: fallbackDir, name: raw}
    }
    const fieldType = (receiver, fieldName) => {
        if (!receiver?.name || !fieldName) return null
        const typeId = dirTypes.get(receiver.dir)?.get(receiver.name)
        const typeNode = typeId && nodeById.get(typeId)
        const rawFieldType = typeNode?.field_types?.[fieldName]
        return rawFieldType ? typeRef(rawFieldType, typeNode.source_file, receiver.dir) : null
    }
    const exactMethod = (receiver, methodName) => {
        const candidates = receiver && dirMethods.get(receiver.dir)?.get(receiver.name)?.get(methodName)
        return candidates?.length === 1 ? candidates[0] : null
    }
    const uniqueMethod = (dir, methodName) => {
        const candidates = dirMethodsByName.get(dir)?.get(methodName) || []
        return candidates.length === 1 ? candidates[0] : null
    }
    const returnType = (targetId, callerFile) => {
        const target = targetId && nodeById.get(targetId)
        return target?.return_type
            ? typeRef(target.return_type, target.source_file || callerFile, dirOf(target.source_file || callerFile))
            : null
    }
    const fieldChildren = (node, name) => {
        const children = node?.childrenForFieldName?.(name)
        if (Array.isArray(children) && children.length) return children
        const child = node?.childForFieldName?.(name)
        return child ? [child] : []
    }
    const receiverBindings = (selector, file) => {
        const bindings = new Map()
        let scope = selector
        while (scope?.parent && !['function_declaration', 'method_declaration'].includes(scope.type)) scope = scope.parent
        if (!scope || !['function_declaration', 'method_declaration'].includes(scope.type)) return bindings
        const callRow = selector.startPosition.row
        const containsCall = (node) => node.startIndex <= selector.startIndex && node.endIndex >= selector.endIndex
        const expressionType = (node) => {
            if (!node) return null
            const declared = goTypeName(node)
            if (declared) return typeRef(declared, file)
            if (['parenthesized_expression', 'unary_expression'].includes(node.type)) {
                return expressionType(node.childForFieldName?.('operand') || node.namedChildren?.[0])
            }
            if (node.type === 'composite_literal') return typeRef(goTypeName(node.childForFieldName?.('type')), file)
            if (node.type === 'identifier') return bindings.get(node.text) || null
            if (node.type === 'selector_expression') return fieldType(expressionType(node.childForFieldName?.('operand')), node.childForFieldName?.('field')?.text)
            if (node.type !== 'call_expression') return null
            const fn = node.childForFieldName?.('function')
            if (fn?.type === 'identifier') {
                const returned = returnType(resolveCall(fn.text, file), file)
                if (returned) return returned
                if (dirTypes.get(dirOf(file))?.has(fn.text)) return typeRef(fn.text, file)
                if (/^New[A-Z_]/.test(fn.text)) return typeRef(fn.text.slice(3), file)
            }
            if (fn?.type === 'selector_expression') {
                const operand = fn.childForFieldName?.('operand'), member = fn.childForFieldName?.('field')?.text
                const imported = operand?.type === 'identifier' && importedLocals.get(file)?.get(operand.text)
                if (imported?.targetDir && member) {
                    const returned = returnType(dirSymbols.get(imported.targetDir)?.get(member), file)
                    if (returned) return returned
                    if (/^New[A-Z_]/.test(member)) return {dir: imported.targetDir, name: member.slice(3)}
                }
            }
            return null
        }
        const bindTyped = (node) => {
            const reference = typeRef(goTypeName(node.childForFieldName?.('type')), file)
            const names = fieldChildren(node, 'name').filter((name) => ['identifier', 'field_identifier'].includes(name.type))
            if (reference) for (const name of names) bindings.set(name.text, reference)
            else if (node.type === 'var_spec') {
                const values = node.childForFieldName?.('value')?.namedChildren || []
                for (let index = 0; index < Math.min(names.length, values.length); index++) {
                    const inferred = expressionType(values[index])
                    if (inferred) bindings.set(names[index].text, inferred)
                }
            }
        }
        const bindAssignment = (node) => {
            const left = node.childForFieldName?.('left')?.namedChildren || []
            const right = node.childForFieldName?.('right')?.namedChildren || []
            for (let index = 0; index < Math.min(left.length, right.length); index++) {
                if (left[index].type !== 'identifier') continue
                const inferred = expressionType(right[index])
                if (inferred) bindings.set(left[index].text, inferred)
            }
        }
        const visit = (node) => {
            if (!node || node.startPosition.row > callRow) return
            if (node !== scope && ['function_declaration', 'method_declaration', 'func_literal'].includes(node.type) && !containsCall(node)) return
            if (['parameter_declaration', 'var_spec'].includes(node.type)) bindTyped(node)
            else if (['short_var_declaration', 'assignment_statement'].includes(node.type)) bindAssignment(node)
            for (const child of node.namedChildren || []) visit(child)
        }
        visit(scope)
        return bindings
    }
    return {dirOf, fieldType, exactMethod, uniqueMethod, receiverBindings}
}
