// Syntax node-type and call-name tables for the source-complexity analysis.

export const LOOP_NODES = new Set([
  "for_statement", "for_in_statement", "for_each_statement", "enhanced_for_statement",
  "while_statement", "do_statement", "for_in_clause"
]);
export const CALL_NODES = new Set(["call", "call_expression", "method_invocation", "object_creation_expression"]);
export const RETURN_NODES = new Set(["return_statement"]);
export const AWAIT_NODES = new Set(["await_expression"]);
export const OBJECT_NODES = new Set(["object", "dictionary", "map", "record_literal"]);
export const FIXED_ALLOCATION_NODES = new Set([
  ...OBJECT_NODES,
  "array", "list", "set", "tuple", "composite_literal", "new_expression",
  "object_creation_expression", "array_creation_expression", "make_expression",
  "list_comprehension", "set_comprehension", "dictionary_comprehension"
]);
export const VARIABLE_ALLOCATION_NODES = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension"]);
export const SPREAD_NODES = new Set([
  "spread_element", "list_splat", "dictionary_splat", "set_splat", "spread_expression"
]);
export const DECLARATION_BOUNDARIES = new Set([
  "function_declaration", "generator_function_declaration", "function_definition",
  "method_definition", "method_declaration", "constructor_declaration",
  "class_declaration", "class_definition", "interface_declaration", "enum_declaration"
]);
export const EXPRESSION_CALLABLES = new Set([
  "arrow_function", "function_expression", "generator_function", "lambda", "lambda_expression"
]);
export const ARGUMENT_NODES = new Set(["arguments", "argument_list"]);
export const ITERATOR_CALLS = new Set([
  "foreach", "map", "flatmap", "filter", "reduce", "reduceright", "some", "every",
  "find", "findindex", "findlast", "findlastindex", "collect", "select"
]);
export const PRODUCER_CALLS = new Set([
  "map", "flatmap", "filter", "slice", "concat", "split", "toarray", "tolist",
  "keys", "values", "entries", "fromentries", "from", "copy", "clone", "collect", "make",
  "all", "allsettled", "stringify", "parse"
]);
export const LINEAR_CALLS = new Set([
  ...ITERATOR_CALLS,
  ...PRODUCER_CALLS,
  "includes", "indexof", "lastindexof", "join", "reverse", "stringify", "parse",
  "all", "allsettled", "any", "race"
]);
export const SORT_CALLS = new Set(["sort", "sorted", "sortby", "orderby", "order_by"]);
export const IO_PREFIXES = [
  "fetch", "request", "query", "execute", "insert", "update", "delete", "save", "read",
  "write", "send", "publish", "consume", "find", "load", "download", "upload", "connect", "transaction"
];

export const BRANCH_NODES = new Set([
  "if_statement", "elif_clause", "catch_clause", "except_clause", "conditional_expression",
  "ternary_expression", "switch_case", "case_statement", "expression_case", "type_case",
  "communication_case", "match_case"
]);
