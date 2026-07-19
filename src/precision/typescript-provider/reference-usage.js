import {extname} from 'node:path'
import {createRequire} from 'node:module'

const requireFromWeavatrix = createRequire(import.meta.url)

function typeScriptScriptKind(ts, filePath) {
    const extension = extname(String(filePath)).toLowerCase()
    if (extension === '.tsx') return ts.ScriptKind.TSX
    if (extension === '.jsx') return ts.ScriptKind.JSX
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
    return ts.ScriptKind.TS
}

// Unknown is deliberately fail-closed: callers must not promote it to runtime.
export function classifyTypeScriptReferenceUsage(filePath, text, position) {
    if (!Number.isInteger(position?.line) || !Number.isInteger(position?.character)) return 'unknown'
    let ts
    try { ts = requireFromWeavatrix('typescript') } catch { return 'unknown' }
    let sourceFile
    let offset
    try {
        sourceFile = ts.createSourceFile(
            String(filePath || 'source.ts'),
            String(text || ''),
            ts.ScriptTarget.Latest,
            true,
            typeScriptScriptKind(ts, filePath),
        )
        if (sourceFile.parseDiagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
            return 'unknown'
        }
        offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character)
    } catch { return 'unknown' }
    let token
    try { token = ts.getTokenAtPosition(sourceFile, offset) } catch { return 'unknown' }
    if (!token || (!ts.isIdentifier(token) && !ts.isPrivateIdentifier(token))) return 'unknown'
    if (offset < token.getStart(sourceFile) || offset >= token.getEnd()) return 'unknown'
    for (let current = token; current && current !== sourceFile; current = current.parent) {
        if ((ts.isImportSpecifier(current) || ts.isImportClause(current)
            || ts.isExportSpecifier(current) || ts.isExportDeclaration(current))
            && current.isTypeOnly === true) return 'type'
        if (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent)) {
            const heritage = current.parent
            if (heritage.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(heritage.parent)) {
                const expression = current.expression
                if (offset >= expression.getStart(sourceFile) && offset < expression.getEnd()) return 'value'
            }
            return 'type'
        }
        if (ts.isTypeNode(current)) return 'type'
    }
    return 'value'
}
