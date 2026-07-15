// Resolve Java type usages only when they land on declarations that exist in the graph. Synthetic nodes for
// String/List/annotations inflate metrics without adding navigation value, so unresolved/external types vanish.
export function addJavaReferences({ grammar, tree, fileRel, caps, resolveJavaType, enclosing, links }) {
  const refSeen = new Set();
  const isHeritage = (node) => {
    let current = node?.parent;
    for (let hops = 0; current && hops < 8; hops++, current = current.parent) {
      if (["superclass", "super_interfaces", "extends_interfaces"].includes(current.type)) return true;
      if (["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"].includes(current.type)) return false;
    }
    return false;
  };
  const emitTypeRef = (name, node) => {
    if (!name || isHeritage(node)) return;
    const target = resolveJavaType(name, fileRel);
    if (!target) return;
    const owner = enclosing(fileRel, node.startPosition.row + 1);
    const source = owner?.id || fileRel;
    if (source === target) return;
    const key = `${source}>${target}`;
    if (refSeen.has(key)) return;
    refSeen.add(key);
    links.push({ source, target, relation: "references", confidence: "INFERRED", usage: "type", line: node.startPosition.row + 1 });
  };
  for (const cap of caps(grammar, `(type_identifier) @type`, tree.rootNode)) {
    // A qualified type is handled once by its outer scoped_type_identifier. Inner package segments could
    // otherwise bind to unrelated same-named project types.
    if (cap.node.parent?.type !== "scoped_type_identifier") emitTypeRef(cap.node.text, cap.node);
  }
  for (const cap of caps(grammar, `(scoped_type_identifier) @type`, tree.rootNode)) {
    if (cap.node.parent?.type !== "scoped_type_identifier") emitTypeRef(cap.node.text.split(".").pop(), cap.node);
  }
}
