// Import-statement structure for JS/TS, for organize_imports (unused-import removal). Built
// on the same bundled tree-sitter grammars as js-call-sites.js. Safety rule the producer
// relies on: an imported local binding is removable ONLY when its name occurs exactly once in
// the whole file (the import itself) — so a used import (including type positions, JSX, and
// shorthand) can never be removed. Anything ambiguous is left for the caller to report.

const IDENTIFIER_TYPES = new Set(['identifier', 'type_identifier', 'shorthand_property_identifier', 'property_identifier'])

const pos = (node, which) => {
    const position = which === 'start' ? node.startPosition : node.endPosition
    const index = which === 'start' ? node.startIndex : node.endIndex
    return {line: position.row + 1, char: position.column, index}
}

// name -> count of every identifier-like token in the file (import bindings INCLUDED), so
// count === 1 for a binding means its sole occurrence is the import declaration.
export function countIdentifierNames(tree) {
    const counts = new Map()
    if (!tree) return counts
    const stack = [tree.rootNode]
    while (stack.length) {
        const node = stack.pop()
        if (IDENTIFIER_TYPES.has(node.type)) counts.set(node.text, (counts.get(node.text) || 0) + 1)
        for (const child of node.namedChildren) stack.push(child)
    }
    return counts
}

function bindingsOf(statement) {
    const clause = statement.namedChildren.find((child) => child.type === 'import_clause')
    if (!clause) return {sideEffect: true, bindings: [], named: null}
    const bindings = []
    let named = null
    for (const child of clause.namedChildren) {
        if (child.type === 'identifier') bindings.push({kind: 'default', local: child.text, node: child})
        else if (child.type === 'namespace_import') {
            const id = child.namedChildren.find((node) => node.type === 'identifier')
            if (id) bindings.push({kind: 'namespace', local: id.text, node: child})
        } else if (child.type === 'named_imports') {
            named = child
            for (const specifier of child.namedChildren) {
                if (specifier.type !== 'import_specifier') continue
                const nameNode = specifier.childForFieldName('name')
                const aliasNode = specifier.childForFieldName('alias')
                const localNode = aliasNode || nameNode
                if (localNode) bindings.push({kind: 'named', local: localNode.text, node: specifier})
            }
        }
    }
    return {sideEffect: false, bindings, named}
}

// Every import_statement with its bindings, statement span, and named-imports list. `typeOnly`
// flags `import type ...` (the whole statement is types). Positions are UTF-16 line/char.
export function collectImports(tree) {
    if (!tree) return []
    const imports = []
    const stack = [tree.rootNode]
    while (stack.length) {
        const node = stack.pop()
        if (node.type === 'import_statement') {
            const {sideEffect, bindings, named} = bindingsOf(node)
            imports.push({
                start: pos(node, 'start'),
                end: pos(node, 'end'),
                sideEffect,
                typeOnly: /^import\s+type\b/.test(node.text),
                bindings,
                named: named ? {node: named, specifiers: named.namedChildren.filter((child) => child.type === 'import_specifier').map((child) => ({start: pos(child, 'start'), end: pos(child, 'end')})) } : null,
            })
        }
        for (const child of node.namedChildren) stack.push(child)
    }
    return imports
}

export {pos as importPos}
