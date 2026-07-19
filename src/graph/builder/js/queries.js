export const CALLABLE = /arrow_function|function|function_expression|generator_function/

export const FUNCS = `
  (function_declaration name: (identifier) @fn)
  (generator_function_declaration name: (identifier) @fn)
  (class_declaration name: (_) @class)
  (method_definition name: (_) @method)`

export const TOPVARS = `
  (program (lexical_declaration (variable_declarator) @decl))
  (program (variable_declaration (variable_declarator) @decl))
  (program (export_statement (lexical_declaration (variable_declarator) @decl)))
  (program (export_statement (variable_declaration (variable_declarator) @decl)))`

export const TYPES = `
  (interface_declaration name: (_) @interface)
  (type_alias_declaration name: (_) @type)
  (enum_declaration name: (_) @enum)`

export const REQUIRE = `(variable_declarator name: (_) @lhs value: (call_expression function: (identifier) @req arguments: (arguments (string (string_fragment) @src))))`

export function parseExportSpecifiers(raw) {
  return String(raw || '').split(',').map((part) => {
    const text = part.trim()
    const typeOnly = /^type\s+/.test(text)
    const clean = text.replace(/^type\s+/, '').trim()
    const match = clean.match(/^([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*|default))?$/)
    return match ? {imported: match[1], exported: match[2] || match[1], typeOnly} : null
  }).filter(Boolean)
}

export function importTypeOnly(node) {
  if (/^\s*import\s+type\b/.test(node.text)) return true
  const clause = node.namedChildren.find((child) => child.type === 'import_clause')
  if (!clause) return false
  const parts = clause.namedChildren
  if (parts.some((child) => child.type === 'identifier' || child.type === 'namespace_import')) return false
  const named = parts.find((child) => child.type === 'named_imports')
  const specifiers = named?.namedChildren.filter((child) => child.type === 'import_specifier') || []
  return specifiers.length > 0 && specifiers.every((specifier) => /^\s*type\b/.test(specifier.text))
}

export function reexportTypeOnly(node) {
  if (/^\s*export\s+type\b/.test(node.text)) return true
  const clause = node.namedChildren.find((child) => child.type === 'export_clause')
  const specifiers = clause?.namedChildren.filter((child) => child.type === 'export_specifier') || []
  return specifiers.length > 0 && specifiers.every((specifier) => /^\s*type\b/.test(specifier.text))
}
