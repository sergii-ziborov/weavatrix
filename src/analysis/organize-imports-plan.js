// organize_imports plan producer (JS/TS v1): removes provably-unused NAMED import
// specifiers as a weavatrix.edit-plan.v1. Deliberately narrow for safety: a binding is
// removed only when its name occurs exactly once in the file (the import itself), and only
// named specifiers are removed — default/namespace imports can be implicitly used (a JSX
// factory like React, or a side-effect) and are reported UNCERTAIN instead of guessed.
// Canonical ordering/grouping is left to the language formatter (gofmt/isort/eslint); this
// tool does only the part the formatter cannot: knowing which imports are unused.
// The graph+lexical backend pattern generalizes to other languages; JS/TS ships first.

import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {grammarForFile, parseJsTs} from './js-call-sites.js'
import {collectImports, countIdentifierNames} from './js-imports.js'

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

// Byte-exact removal of a named specifier at `index`, consuming exactly one comma so the
// remaining `{ ... }` stays well-formed.
function removalRange(specifiers, index, content) {
    const count = specifiers.length
    const item = specifiers[index]
    let from
    let to
    if (count === 1) { from = item.start; to = item.end }
    else if (index < count - 1) { from = item.start; to = specifiers[index + 1].start }
    else { from = specifiers[index - 1].end; to = item.end }
    return {startLine: from.line, startChar: from.char, endLine: to.line, endChar: to.char, before: content.slice(from.index, to.index), after: '', provenance: 'EXTRACTED'}
}

function statementRemoval(statement, content) {
    const newline = content.indexOf('\n', statement.end.index)
    const endIndex = newline === -1 ? content.length : newline + 1
    const endLine = newline === -1 ? statement.end.line : statement.end.line + 1
    const endChar = newline === -1 ? statement.end.char : 0
    return {startLine: statement.start.line, startChar: statement.start.char, endLine, endChar, before: content.slice(statement.start.index, endIndex), after: '', provenance: 'EXTRACTED'}
}

export async function buildOrganizeImportsPlan({repoRoot, file} = {}) {
    if (!repoRoot || !file) throw new Error('organize_imports requires repoRoot and file')
    const grammar = grammarForFile(file)
    if (!grammar) return {status: 'NOT_SUPPORTED', reason: 'organize_imports currently supports JavaScript and TypeScript files'}
    let content
    try {
        const buffer = readFileSync(resolve(repoRoot, String(file)))
        content = buffer.toString('utf8')
        if (!Buffer.from(content, 'utf8').equals(buffer)) return {status: 'SOURCE_UNAVAILABLE', reason: `${file}: not valid UTF-8 text`}
    } catch {
        return {status: 'SOURCE_UNAVAILABLE', reason: `${file}: unreadable`}
    }

    const tree = await parseJsTs(content, grammar)
    if (!tree) return {status: 'PARSE_FAILED', reason: `${file}: could not be parsed`}
    const counts = countIdentifierNames(tree)
    const imports = collectImports(tree)

    const edits = []
    const uncertain = []
    const warnings = new Set(['SORTING_NOT_APPLIED', 'UNUSED_NAMED_REMOVAL_ONLY'])
    const isUnused = (binding) => (counts.get(binding.local) || 0) === 1

    for (const statement of imports) {
        if (statement.sideEffect) continue
        const named = statement.bindings.filter((binding) => binding.kind === 'named')
        const other = statement.bindings.filter((binding) => binding.kind !== 'named')
        for (const binding of other) {
            if (isUnused(binding)) uncertain.push({file, line: statement.start.line, name: binding.local, kind: binding.kind, reason: 'DEFAULT_OR_NAMESPACE_UNUSED_POSSIBLE_IMPLICIT_USE'})
        }
        if (!named.length) continue
        const unusedNamed = named.filter(isUnused)
        if (!unusedNamed.length) continue
        if (!other.length && unusedNamed.length === named.length) {
            edits.push({file, ...statementRemoval(statement, content)})
            continue
        }
        // remove individual specifiers, highest index first so earlier ranges stay valid
        const indices = unusedNamed
            .map((binding) => statement.named.specifiers.findIndex((specifier) => specifier.start.index === binding.node.startIndex))
            .filter((index) => index >= 0)
            .sort((a, b) => b - a)
        for (const index of indices) edits.push({file, ...removalRange(statement.named.specifiers, index, content)})
    }

    if (uncertain.length) warnings.add('UNCERTAIN_IMPORTS_PRESENT')
    if (!edits.length) return {status: 'NO_UNUSED_IMPORTS', reason: 'no provably-unused named import was found', uncertain, warnings: [...warnings]}

    return {
        status: 'PLANNED',
        file,
        removed: edits.length,
        completeness: uncertain.length ? 'PARTIAL' : 'COMPLETE',
        plan: {
            schemaVersion: 'weavatrix.edit-plan.v1',
            operation: 'organize_imports',
            createdAt: new Date().toISOString(),
            completeness: uncertain.length ? 'PARTIAL' : 'COMPLETE',
            files: [{path: String(file), sha256: sha256Hex(Buffer.from(content, 'utf8')), edits}],
            uncertainReferences: uncertain,
            notModified: [],
            warnings: [...warnings],
            followUp: 'removes only unused named imports; run the language formatter for ordering, then verified_change phase=verify',
        },
    }
}
