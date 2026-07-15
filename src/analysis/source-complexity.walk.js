// Syntax-tree walk that gathers complexity stats and assembles the summary report.

import {
  LOOP_NODES, CALL_NODES, RETURN_NODES, AWAIT_NODES, OBJECT_NODES,
  FIXED_ALLOCATION_NODES, VARIABLE_ALLOCATION_NODES, SPREAD_NODES,
  DECLARATION_BOUNDARIES, EXPRESSION_CALLABLES, ARGUMENT_NODES,
  ITERATOR_CALLS, PRODUCER_CALLS, LINEAR_CALLS, SORT_CALLS, BRANCH_NODES
} from "./source-complexity.constants.js";
import {
  field, children, sameNode, normalizedName, looksLikeIoCall, callName,
  logicalBranch, isDefaultCase, directParameterCount, countObjectPatternFields, sourceRange
} from "./source-complexity.ast.js";
import { buildLabels, buildEvidence } from "./source-complexity.report.js";

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
