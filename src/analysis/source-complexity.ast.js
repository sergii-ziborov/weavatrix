// Tree-sitter node helpers shared by the source-complexity analysis modules.

import { IO_PREFIXES } from "./source-complexity.constants.js";

export function field(node, name) {
  try { return node?.childForFieldName ? node.childForFieldName(name) : null; }
  catch { return null; }
}

export function children(node) {
  try { return Array.isArray(node?.namedChildren) ? node.namedChildren : []; }
  catch { return []; }
}

export function allChildren(node) {
  try { return Array.isArray(node?.children) ? node.children : children(node); }
  catch { return children(node); }
}

export function sameNode(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.id != null && right.id != null) return left.id === right.id;
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

export function normalizedName(value) {
  return String(value || "").replace(/[^A-Za-z0-9_$]+/g, "").toLowerCase();
}

export function looksLikeIoCall(value) {
  const raw = String(value || "");
  const lower = raw.toLowerCase();
  return IO_PREFIXES.some((prefix) => {
    if (!lower.startsWith(prefix)) return false;
    const boundary = raw[prefix.length];
    return boundary == null || /[A-Z_$]/.test(boundary);
  });
}

export function callName(node) {
  const callee = field(node, "function") || field(node, "name") || field(node, "constructor");
  if (!callee) return "";
  const member = field(callee, "property") || field(callee, "field") || field(callee, "attribute") || field(callee, "name");
  return String((member || callee).text || "").replace(/\?$/, "");
}

export function logicalBranch(node) {
  if (!/binary_expression|boolean_operator/.test(String(node?.type || ""))) return false;
  return allChildren(node).some((child) => ["&&", "||", "??", "and", "or"].includes(String(child?.type || child?.text || "")));
}

export function isDefaultCase(node) {
  const text = String(node?.text || "").trimStart();
  return /^(default\b|case\s+default\b)/i.test(text);
}

export function directParameterCount(paramNode, family) {
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

export function countObjectPatternFields(paramNode) {
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

export function sourceRange(node) {
  const startLine = node?.startPosition ? node.startPosition.row + 1 : 0;
  const endLine = node?.endPosition ? node.endPosition.row + 1 : startLine;
  return { startLine, endLine, loc: startLine ? Math.max(1, endLine - startLine + 1) : 0 };
}
