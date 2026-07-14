// AST-backed, language-aware source complexity summary.
//
// This intentionally reports LOCAL algorithmic work separately from calls/I/O. A method with no loop
// can be O(1) locally while its end-to-end latency remains callee-bound; object/array spreads are linear
// shallow copies even without an explicit loop. Reports are plain JSON and are persisted on graph nodes,
// so the renderer never needs a second implementation of the algorithm.

const LOOP_NODES = new Set([
  "for_statement", "for_in_statement", "for_each_statement", "enhanced_for_statement",
  "while_statement", "do_statement", "for_in_clause"
]);
const CALL_NODES = new Set(["call", "call_expression", "method_invocation", "object_creation_expression"]);
const RETURN_NODES = new Set(["return_statement"]);
const AWAIT_NODES = new Set(["await_expression"]);
const OBJECT_NODES = new Set(["object", "dictionary", "map", "record_literal"]);
const FIXED_ALLOCATION_NODES = new Set([
  ...OBJECT_NODES,
  "array", "list", "set", "tuple", "composite_literal", "new_expression",
  "object_creation_expression", "array_creation_expression", "make_expression",
  "list_comprehension", "set_comprehension", "dictionary_comprehension"
]);
const VARIABLE_ALLOCATION_NODES = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension"]);
const SPREAD_NODES = new Set([
  "spread_element", "list_splat", "dictionary_splat", "set_splat", "spread_expression"
]);
const DECLARATION_BOUNDARIES = new Set([
  "function_declaration", "generator_function_declaration", "function_definition",
  "method_definition", "method_declaration", "constructor_declaration",
  "class_declaration", "class_definition", "interface_declaration", "enum_declaration"
]);
const EXPRESSION_CALLABLES = new Set([
  "arrow_function", "function_expression", "generator_function", "lambda", "lambda_expression"
]);
const ARGUMENT_NODES = new Set(["arguments", "argument_list"]);
const ITERATOR_CALLS = new Set([
  "foreach", "map", "flatmap", "filter", "reduce", "reduceright", "some", "every",
  "find", "findindex", "findlast", "findlastindex", "collect", "select"
]);
const PRODUCER_CALLS = new Set([
  "map", "flatmap", "filter", "slice", "concat", "split", "toarray", "tolist",
  "keys", "values", "entries", "fromentries", "from", "copy", "clone", "collect", "make",
  "all", "allsettled", "stringify", "parse"
]);
const LINEAR_CALLS = new Set([
  ...ITERATOR_CALLS,
  ...PRODUCER_CALLS,
  "includes", "indexof", "lastindexof", "join", "reverse", "stringify", "parse",
  "all", "allsettled", "any", "race"
]);
const SORT_CALLS = new Set(["sort", "sorted", "sortby", "orderby", "order_by"]);
const IO_PREFIXES = [
  "fetch", "request", "query", "execute", "insert", "update", "delete", "save", "read",
  "write", "send", "publish", "consume", "find", "load", "download", "upload", "connect", "transaction"
];

const BRANCH_NODES = new Set([
  "if_statement", "elif_clause", "catch_clause", "except_clause", "conditional_expression",
  "ternary_expression", "switch_case", "case_statement", "expression_case", "type_case",
  "communication_case", "match_case"
]);

function field(node, name) {
  try { return node?.childForFieldName ? node.childForFieldName(name) : null; }
  catch { return null; }
}

function children(node) {
  try { return Array.isArray(node?.namedChildren) ? node.namedChildren : []; }
  catch { return []; }
}

function allChildren(node) {
  try { return Array.isArray(node?.children) ? node.children : children(node); }
  catch { return children(node); }
}

function sameNode(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.id != null && right.id != null) return left.id === right.id;
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

function normalizedName(value) {
  return String(value || "").replace(/[^A-Za-z0-9_$]+/g, "").toLowerCase();
}

function looksLikeIoCall(value) {
  const raw = String(value || "");
  const lower = raw.toLowerCase();
  return IO_PREFIXES.some((prefix) => {
    if (!lower.startsWith(prefix)) return false;
    const boundary = raw[prefix.length];
    return boundary == null || /[A-Z_$]/.test(boundary);
  });
}

function callName(node) {
  const callee = field(node, "function") || field(node, "name") || field(node, "constructor");
  if (!callee) return "";
  const member = field(callee, "property") || field(callee, "field") || field(callee, "attribute") || field(callee, "name");
  return String((member || callee).text || "").replace(/\?$/, "");
}

function logicalBranch(node) {
  if (!/binary_expression|boolean_operator/.test(String(node?.type || ""))) return false;
  return allChildren(node).some((child) => ["&&", "||", "??", "and", "or"].includes(String(child?.type || child?.text || "")));
}

function isDefaultCase(node) {
  const text = String(node?.text || "").trimStart();
  return /^(default\b|case\s+default\b)/i.test(text);
}

function directParameterCount(paramNode, family) {
  if (!paramNode) return 0;
  if (!/parameters|parameter_list|formal_parameters/.test(String(paramNode.type || ""))) {
    return /^(self|cls)$/.test(String(paramNode.text || "").trim()) ? 0 : 1;
  }
  let count = 0;
  for (const part of children(paramNode)) {
    const type = String(part.type || "");
    if (/comment|type_parameter|type_parameters/.test(type)) continue;
    if (family === "go" && /parameter_declaration|variadic_parameter_declaration/.test(type)) {
      const ids = children(part).filter((child) => /^(identifier|field_identifier)$/.test(String(child.type || "")));
      count += Math.max(1, ids.length);
      continue;
    }
    if (/^(self|cls)(\s*[:=].*)?$/.test(String(part.text || "").trim())) continue;
    count++;
  }
  return count;
}

function countObjectPatternFields(paramNode) {
  if (!paramNode) return 0;
  let total = 0;
  const visit = (node, depth) => {
    if (!node || depth > 5) return;
    if (node.type === "object_pattern") {
      total += children(node).filter((child) => !/type_annotation|comment/.test(String(child.type || ""))).length;
      return;
    }
    for (const child of children(node)) visit(child, depth + 1);
  };
  visit(paramNode, 0);
  return total;
}

function sourceRange(node) {
  const startLine = node?.startPosition ? node.startPosition.row + 1 : 0;
  const endLine = node?.endPosition ? node.endPosition.row + 1 : startLine;
  return { startLine, endLine, loc: startLine ? Math.max(1, endLine - startLine + 1) : 0 };
}

function timeScore(rank) {
  return [0.2, 0.4, 0.65, 0.95, 1.3, 1.7][Math.max(0, Math.min(5, rank))] || 0.2;
}

function memoryScore(rank) {
  return [0.15, 0.35, 0.85, 1.05, 1.4, 1.7][Math.max(0, Math.min(5, rank))] || 0.15;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function deriveTimeRank(stats) {
  if (stats.maxLoopDepth >= 3) return 5;
  if (stats.maxLoopDepth === 2 || (stats.sorts && stats.maxSortLoopDepth > 0)) return 4;
  if (stats.sorts) return 3;
  if (stats.loops || stats.linearOps || stats.spreadCopies) return 2;
  return 0;
}

function timeLabelForRank(stats, rank) {
  if (stats.recursion) return "recursive local work — bound unknown";
  if (rank >= 5) return "O(n^3+) local — deeply nested iteration";
  if (rank === 4 && stats.sorts && stats.maxSortLoopDepth > 0) return "O(n^2 log n) local — sort inside iteration";
  if (rank === 4) return "O(n^2) local — nested iteration";
  if (rank === 3) return "O(n log n) local — sort";
  if (rank === 2 && stats.spreadCopies) return `O(n) local — ${plural(stats.spreadCopies, "shallow copy", "shallow copies")}`;
  if (rank === 2 && stats.loops) return `O(n) local — ${plural(stats.loops, "iteration", "iterations")}`;
  return rank === 2 ? "O(n) local — collection traversal" : "O(1) local";
}

function buildTimeSummary(stats) {
  const timeRank = stats.recursion ? Math.max(2, deriveTimeRank(stats)) : deriveTimeRank(stats);
  let timeLabel = timeLabelForRank(stats, timeRank);
  if (stats.asyncBoundaries || stats.externalCalls) timeLabel += " · I/O/callee-bound";
  else if (stats.callCount && !stats.recursion) timeLabel += " · callee-bound";
  if (stats.branches >= 8 && timeRank === 0) timeLabel += " · branch-heavy";
  return { timeRank, timeScore: timeScore(timeRank), timeLabel };
}

function buildMemorySummary(stats) {
  let memoryRank = 0;
  let memoryLabel = "O(1) auxiliary";
  const variableAllocation = stats.spreadCopies || stats.producerCalls;
  if (variableAllocation) {
    memoryRank = stats.maxVariableAllocationDepth >= 2 ? 4 : 2;
    memoryLabel = memoryRank >= 4 ? "O(n^2) — nested collection copies" : stats.spreadCopies
      ? `O(n) — ${plural(stats.spreadCopies, "shallow copy", "shallow copies")}`
      : "O(n) — produced collection";
  } else if (stats.recursion) {
    memoryRank = 1;
    memoryLabel = "O(depth) stack — recursive";
  } else if (stats.allocations) {
    memoryLabel = "O(1) auxiliary — fixed allocations";
  }
  return { memoryRank, memoryScore: memoryScore(memoryRank), memoryLabel };
}

function buildLabels(stats) {
  return { ...buildTimeSummary(stats), ...buildMemorySummary(stats) };
}

function buildEvidence(stats) {
  const out = [];
  if (stats.loops) out.push(plural(stats.loops, "iteration", "iterations"));
  if (stats.maxLoopDepth > 1) out.push(`loop depth ${stats.maxLoopDepth}`);
  if (stats.sorts) out.push(plural(stats.sorts, "sort", "sorts"));
  if (stats.spreadCopies) out.push(plural(stats.spreadCopies, "shallow copy", "shallow copies"));
  if (stats.branches) out.push(plural(stats.branches, "branch point", "branch points"));
  if (stats.awaits) out.push(plural(stats.awaits, "await boundary", "await boundaries"));
  if (stats.callCount) out.push(plural(stats.callCount, "call", "calls"));
  if (stats.recursion) out.push("direct recursion");
  return out;
}

function createStats(parameters, family) {
  return {
    params: directParameterCount(parameters, family),
    objectFields: countObjectPatternFields(parameters),
    branches: 0,
    loops: 0,
    maxLoopDepth: 0,
    returns: 0,
    awaits: 0,
    callCount: 0,
    externalCalls: 0,
    asyncBoundaries: 0,
    allocations: 0,
    objectLiterals: 0,
    spreadCopies: 0,
    sorts: 0,
    linearOps: 0,
    producerCalls: 0,
    recursion: false,
    maxSortLoopDepth: 0,
    maxVariableAllocationDepth: 0
  };
}

function shouldSkipNode(root, node, state) {
  if (sameNode(node, root)) return false;
  const type = String(node.type || "");
  if (DECLARATION_BOUNDARIES.has(type)) return true;
  if (!EXPRESSION_CALLABLES.has(type) || state.callbackContext) return false;
  const parent = state.parent;
  return !(CALL_NODES.has(String(parent?.type || "")) && sameNode(field(parent, "function"), node));
}

function nodeFacts(node, state) {
  const type = String(node.type || "");
  const isCall = CALL_NODES.has(type);
  const nameAtCall = isCall ? callName(node) : "";
  const normalizedCall = normalizedName(nameAtCall);
  return {
    type,
    isCall,
    isLoop: LOOP_NODES.has(type),
    nameAtCall,
    normalizedCall,
    iteratorCall: isCall && ITERATOR_CALLS.has(normalizedCall),
    sortCall: isCall && SORT_CALLS.has(normalizedCall),
    producerCall: isCall && PRODUCER_CALLS.has(normalizedCall),
    currentDepth: Math.max(0, Number(state.loopDepth) || 0)
  };
}

function recordBasicSignals(stats, node, facts) {
  const { type, currentDepth } = facts;
  if (BRANCH_NODES.has(type) && !(type.includes("case") && isDefaultCase(node))) stats.branches++;
  else if (logicalBranch(node)) stats.branches++;
  if (RETURN_NODES.has(type)) stats.returns++;
  if (AWAIT_NODES.has(type)) { stats.awaits++; stats.asyncBoundaries++; }
  if (OBJECT_NODES.has(type)) stats.objectLiterals++;
  if (FIXED_ALLOCATION_NODES.has(type)) stats.allocations++;
  if (!VARIABLE_ALLOCATION_NODES.has(type)) return;
  stats.producerCalls++;
  stats.maxVariableAllocationDepth = Math.max(stats.maxVariableAllocationDepth, currentDepth + 1);
}

function recordSpread(stats, facts, parent) {
  if (!SPREAD_NODES.has(facts.type) || /parameters|parameter_list/.test(String(parent?.type || ""))) return;
  stats.spreadCopies++;
  stats.linearOps++;
  stats.maxVariableAllocationDepth = Math.max(stats.maxVariableAllocationDepth, facts.currentDepth + 1);
}

function recordCall(stats, facts, state, targetName) {
  if (!facts.isCall) return;
  stats.callCount++;
  if (state.awaited || looksLikeIoCall(facts.nameAtCall)) stats.externalCalls++;
  if (targetName && facts.normalizedCall === targetName) stats.recursion = true;
  if (facts.sortCall) {
    stats.sorts++;
    stats.maxSortLoopDepth = Math.max(stats.maxSortLoopDepth, facts.currentDepth);
  } else if (LINEAR_CALLS.has(facts.normalizedCall) && !facts.iteratorCall) stats.linearOps++;
  if (!facts.producerCall) return;
  stats.producerCalls++;
  stats.allocations++;
  stats.maxVariableAllocationDepth = Math.max(stats.maxVariableAllocationDepth, facts.currentDepth + 1);
}

function recordLoop(stats, facts) {
  if (!facts.isLoop && !facts.iteratorCall) return facts.currentDepth;
  const nextDepth = facts.currentDepth + 1;
  stats.loops++;
  stats.maxLoopDepth = Math.max(stats.maxLoopDepth, nextDepth);
  return nextDepth;
}

function depthForChild(node, child, facts, nextDepth) {
  const childIsArgs = ARGUMENT_NODES.has(String(child.type || ""));
  if (facts.iteratorCall && childIsArgs) return nextDepth;
  if (!facts.isLoop) return facts.currentDepth;
  const loopBody = field(node, "body");
  if (loopBody) return sameNode(child, loopBody) ? nextDepth : facts.currentDepth;
  return facts.type === "for_in_clause" ? facts.currentDepth : nextDepth;
}

function walkSyntax(root, node, state, context) {
  if (!node || shouldSkipNode(root, node, state)) return;
  const parent = state.parent || null;
  const callbackContext = state.callbackContext || ARGUMENT_NODES.has(String(parent?.type || ""));
  const facts = nodeFacts(node, state);
  recordBasicSignals(context.stats, node, facts);
  recordSpread(context.stats, facts, parent);
  recordCall(context.stats, facts, state, context.targetName);
  const nextDepth = recordLoop(context.stats, facts);
  for (const child of children(node)) {
    const childIsArgs = ARGUMENT_NODES.has(String(child.type || ""));
    walkSyntax(root, child, {
      parent: node,
      loopDepth: depthForChild(node, child, facts, nextDepth),
      callbackContext: callbackContext || childIsArgs,
      awaited: AWAIT_NODES.has(facts.type) && !facts.isCall
    }, context);
  }
}

export function analyzeSyntaxComplexity(root, { family = "", name = "" } = {}) {
  const parameters = field(root, "parameters") || field(root, "parameter");
  const stats = createStats(parameters, family);
  walkSyntax(root, root, {}, { stats, targetName: normalizedName(name) });

  const labels = buildLabels(stats);
  const range = sourceRange(root);
  const evidence = buildEvidence(stats);
  const structuralWork = stats.loops || stats.sorts || stats.spreadCopies || stats.linearOps;
  const confidence = stats.recursion ? "low" : structuralWork ? "medium" : stats.callCount ? "low" : "high";
  return {
    ...range,
    family,
    params: stats.params,
    objectFields: stats.objectFields,
    branches: stats.branches,
    cyclomatic: stats.branches + 1,
    loops: stats.loops,
    maxLoopDepth: stats.maxLoopDepth,
    returns: stats.returns,
    awaits: stats.awaits,
    callCount: stats.callCount,
    externalCalls: stats.externalCalls,
    asyncBoundaries: stats.asyncBoundaries,
    allocations: stats.allocations,
    objectLiterals: stats.objectLiterals,
    spreadCopies: stats.spreadCopies,
    sorts: stats.sorts,
    linearOps: stats.linearOps,
    recursion: stats.recursion,
    ...labels,
    scope: "local",
    complexityScope: "local",
    confidence,
    evidence
  };
}
