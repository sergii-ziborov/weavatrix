// Java call resolution beyond bare same-file method names. Tree-sitter gives us the declared type of
// fields, parameters and locals; imports/same-package resolution then identifies the project type that
// owns a receiver method. This restores useful cross-file call flow without inventing external nodes or
// pretending to perform compiler-exact overload/dynamic-dispatch resolution.
const TYPE_DECLARATIONS = new Set([
  "class_declaration", "interface_declaration", "enum_declaration",
  "record_declaration", "annotation_type_declaration",
]);
const CALLABLE_DECLARATIONS = new Set([
  "method_declaration", "constructor_declaration", "lambda_expression",
]);
const BINDING_DECLARATIONS = new Set([
  "formal_parameter", "spread_parameter", "catch_formal_parameter",
  "enhanced_for_statement", "resource",
]);

const contains = (scope, node) => scope && node
  && scope.startIndex <= node.startIndex && scope.endIndex >= node.endIndex;

function nearest(node, accepted) {
  for (let current = node?.parent, hops = 0; current && hops < 30; current = current.parent, hops++) {
    if (accepted.has(current.type)) return current;
  }
  return null;
}

function baseTypeName(typeNode, field) {
  if (!typeNode) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "scoped_type_identifier") return typeNode.text.split(".").pop() || null;
  const nested = field(typeNode, "type") || field(typeNode, "element")
    || typeNode.namedChildren?.find((child) => [
      "type_identifier", "scoped_type_identifier", "generic_type", "array_type", "annotated_type",
    ].includes(child.type));
  return nested && nested !== typeNode ? baseTypeName(nested, field) : null;
}

function collectBindings(root, field) {
  const bindings = [];
  const add = (nameNode, typeNode, declaration, scope, allowForward = false) => {
    const typeName = baseTypeName(typeNode, field);
    if (!nameNode?.text || !typeName || !scope) return;
    bindings.push({
      name: nameNode.text,
      typeName,
      declaration,
      scope,
      allowForward,
    });
  };
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "field_declaration" || node.type === "local_variable_declaration") {
      const type = field(node, "type");
      const owner = node.type === "field_declaration"
        ? nearest(node, TYPE_DECLARATIONS)
        : nearest(node, new Set(["block", ...CALLABLE_DECLARATIONS]));
      for (const child of node.namedChildren || []) {
        if (child.type !== "variable_declarator") continue;
        add(field(child, "name"), type, node, owner, node.type === "field_declaration");
      }
    } else if (BINDING_DECLARATIONS.has(node.type)) {
      const scope = node.type === "enhanced_for_statement"
        ? node
        : nearest(node, CALLABLE_DECLARATIONS) || nearest(node, new Set(["catch_clause", "try_with_resources_statement"]));
      add(field(node, "name"), field(node, "type"), node, scope);
    }
    for (const child of node.namedChildren || []) stack.push(child);
  }
  return bindings;
}

function receiverName(node, field) {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (node.type === "scoped_type_identifier") return node.text.split(".").pop() || null;
  if (node.type === "field_access") {
    const object = field(node, "object");
    if (["this", "super"].includes(object?.type)) return field(node, "field")?.text || null;
  }
  return null;
}

function bindingAt(bindings, name, callNode) {
  return bindings
    .filter((item) => item.name === name && contains(item.scope, callNode)
      && (item.allowForward || item.declaration.startIndex <= callNode.startIndex))
    .sort((left, right) => {
      const leftSpan = left.scope.endIndex - left.scope.startIndex;
      const rightSpan = right.scope.endIndex - right.scope.startIndex;
      return leftSpan - rightSpan || right.declaration.startIndex - left.declaration.startIndex;
    })[0] || null;
}

function methodIn(file, name, argumentCount, symIdsByFileName, nodeById) {
  const candidates = (symIdsByFileName.get(file)?.get(name) || [])
    .map((id) => nodeById.get(id))
    .filter((node) => ["method", "constructor"].includes(node?.symbol_kind));
  if (candidates.length === 1) return candidates[0].id;
  const exact = candidates.filter((node) => node.parameter_count === argumentCount);
  return exact.length === 1 ? exact[0].id : null;
}

export function addJavaCalls({
  grammar, tree, fileRel, caps, field, enclosing, links, nodeById,
  symIdsByFileName, resolveCall, resolveJavaType,
}) {
  const bindings = collectBindings(tree.rootNode, field);
  for (const cap of caps(grammar, `(method_invocation) @call`, tree.rootNode)) {
    const call = cap.node;
    const name = field(call, "name")?.text;
    const argumentCount = field(call, "arguments")?.namedChildren?.length ?? 0;
    const caller = enclosing(fileRel, call.startPosition.row + 1);
    if (!name || !caller) continue;

    const receiver = field(call, "object");
    let target = null;
    let resolution = "unqualified";
    if (!receiver || ["this", "super"].includes(receiver.type)) {
      target = resolveCall(name, fileRel);
    } else {
      const localName = receiverName(receiver, field);
      const binding = localName && bindingAt(bindings, localName, call);
      const declaredType = binding?.typeName || localName;
      const typeTarget = declaredType && resolveJavaType(declaredType, fileRel);
      const targetFile = typeTarget && nodeById.get(typeTarget)?.source_file;
      target = targetFile && methodIn(targetFile, name, argumentCount, symIdsByFileName, nodeById);
      resolution = binding ? "receiver-declared-type" : "static-type";
    }
    if (!target || target === caller.id) continue;
    links.push({
      source: caller.id,
      target,
      relation: "calls",
      confidence: "INFERRED",
      line: call.startPosition.row + 1,
      javaResolution: resolution,
    });
  }
}
