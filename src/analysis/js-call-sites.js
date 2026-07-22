// Reusable JS/TS call-site + parameter-list location for change_signature. There is no LSP
// changeSignature request, so we parse with the bundled web-tree-sitter grammars (columns are
// already 0-based UTF-16, matching LSP/edit-plan positions) and compute byte-exact argument
// surgery ourselves. Everything the parse cannot ground returns empty so the caller reports
// UNCERTAIN rather than emit a wrong edit.

import {extname} from 'node:path'
import {Parser, Query, EXT_LANG, ensureParser} from '../graph/internal-builder.langs.js'

const JS_TS_GRAMMARS = new Set(['javascript', 'typescript', 'tsx'])
const FUNCTION_NODES = new Set(['function_declaration', 'function', 'generator_function_declaration', 'method_definition', 'arrow_function', 'function_expression'])

export function grammarForFile(file) {
    const grammar = EXT_LANG[extname(String(file))]
    return JS_TS_GRAMMARS.has(grammar) ? grammar : null
}

export async function parseJsTs(code, grammar) {
    const langs = await ensureParser({}, new Set([grammar]))
    if (!langs[grammar]) return null
    const parser = new Parser()
    parser.setLanguage(langs[grammar])
    try {
        return parser.parse(code)
    } catch {
        return null
    }
}

const point = (node, which) => {
    const position = which === 'start' ? node.startPosition : node.endPosition
    const index = which === 'start' ? node.startIndex : node.endIndex
    return {line: position.row + 1, char: position.column, index}
}

// The invoked name of a callee: foo() -> foo, obj.foo() -> foo, a?.b.foo() -> foo.
function calleeName(functionNode) {
    if (!functionNode) return null
    if (functionNode.type === 'identifier') return functionNode.text
    const property = functionNode.childForFieldName?.('property')
    return property ? property.text : null
}

function argInfo(child) {
    return {
        start: point(child, 'start'),
        end: point(child, 'end'),
        text: child.text,
        isSpread: child.type === 'spread_element',
    }
}

// Every call_expression on 1-based `line` whose callee name === name, with per-argument
// ranges. A call spanning multiple lines is matched on the line its callee starts.
export function findCallSites(tree, name, line) {
    if (!tree) return []
    const results = []
    const stack = [tree.rootNode]
    while (stack.length) {
        const node = stack.pop()
        if (node.type === 'call_expression') {
            const fn = node.childForFieldName('function')
            const args = node.childForFieldName('arguments')
            if (args && calleeName(fn) === name && (fn.startPosition.row + 1) === line) {
                results.push({
                    open: point(args, 'start'),
                    close: point(args, 'end'),
                    args: args.namedChildren.map(argInfo),
                    hasSpread: args.namedChildren.some((child) => child.type === 'spread_element'),
                })
            }
        }
        for (const child of node.namedChildren) stack.push(child)
    }
    return results
}

// The formal parameter list of a function-like declaration named `name` starting on 1-based
// `line`. Returns {close, params:[...]} where close is the point of the ')' so a caller can
// insert before it; null when no matching declaration is found.
export function findParameterList(tree, name, line) {
    if (!tree) return null
    const stack = [tree.rootNode]
    while (stack.length) {
        const node = stack.pop()
        if (FUNCTION_NODES.has(node.type)) {
            const params = node.childForFieldName('parameters')
            const nameNode = node.childForFieldName('name')
            const onLine = node.startPosition.row + 1 === line
            const nameMatches = !name || (nameNode && nameNode.text === name)
            if (params && onLine && nameMatches) {
                const closeIndex = params.endIndex - 1
                const closeColumn = params.endPosition.column - 1
                return {
                    open: point(params, 'start'),
                    close: {line: params.endPosition.row + 1, char: closeColumn, index: closeIndex},
                    params: params.namedChildren.map(argInfo),
                }
            }
        }
        for (const child of node.namedChildren) stack.push(child)
    }
    return null
}
