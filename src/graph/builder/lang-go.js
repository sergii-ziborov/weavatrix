// Go extractor. Symbols: func/method(receiver)/type(struct+interface)/top-level var+const.
// Imports: `import "mod/pkg"` → the package DIRECTORY's files (Go package = dir), resolved via go.mod prefix.
// Unresolved paths are RECORDED as external imports (stdlib → builtin, modules → ecosystem "Go") so
// dependency analysis can diff them against go.mod. Calls: bare `foo()` (same-file + same-package resolve
// in the orchestrator; cross-pkg `pkg.Func()` is a selector — see resolveGoPackage/pass2). No inheritance.
import { goSpecToPkg } from "./spec-pkg.js";

// Return the named Go type behind pointers/generics/parentheses. Qualified names are
// kept (`speaker.Speaker`) so pass 2 can route them through the import alias table.
export function goTypeName(node) {
  if (!node) return null;
  if (node.type === "type_identifier") return node.text;
  if (node.type === "qualified_type") return node.text.replace(/\s+/g, "");
  if (node.type === "generic_type") return goTypeName(node.childForFieldName?.("type") || node.namedChildren?.[0]);
  if (["pointer_type", "parenthesized_type", "unary_expression"].includes(node.type)) {
    return goTypeName(node.childForFieldName?.("type") || node.childForFieldName?.("operand") || node.namedChildren?.[0]);
  }
  if ((node.namedChildren?.length || 0) === 1) return goTypeName(node.namedChildren[0]);
  return null;
}

const namedFieldChildren = (node, name) => {
  const children = node?.childrenForFieldName?.(name);
  if (Array.isArray(children) && children.length) return children;
  const child = node?.childForFieldName?.(name);
  return child ? [child] : [];
};

function goStructFields(typeNode) {
  if (typeNode?.type !== "struct_type") return null;
  const fields = {};
  const visit = (node) => {
    if (!node) return;
    if (node.type === "field_declaration") {
      const type = goTypeName(node.childForFieldName?.("type"));
      if (!type) return;
      const names = namedFieldChildren(node, "name");
      if (names.length) for (const name of names) fields[name.text] = type;
      else {
        // An embedded field is addressed by the base type name (`h.Speaker`).
        const embedded = type.split(".").pop();
        if (embedded) fields[embedded] = type;
      }
      return;
    }
    for (const child of node.namedChildren || []) visit(child);
  };
  visit(typeNode);
  return fields;
}

function goResultType(declaration) {
  const result = declaration?.childForFieldName?.("result");
  if (!result) return null;
  if (result.type !== "parameter_list") return goTypeName(result);
  const declarations = (result.namedChildren || []).filter((child) => child.type === "parameter_declaration");
  // A call used in `value, err := New()` contributes its first result to the
  // first binding. Preserve that receiver type instead of discarding every
  // multi-result signature just because a trailing error is present.
  return goTypeName(declarations[0]?.childForFieldName?.("type"));
}

export default {
  family: "go",
  grammars: ["go"],
  exts: { ".go": "go" },
  isWeb: false,
  calls: `(call_expression function: (identifier) @callee)`,
  // cross-package `pkg.Func()` — the orchestrator resolves @operand (imported package alias) → its dir, then
  // finds the method there. Without this, funcs called only from other packages look falsely DEAD.
  selectorCall: `(call_expression function: (selector_expression) @sel)`,
  heritage: [],

  pass1(ctx) {
    const { grammar, tree, fileRel, caps, addSym, addImportEdge, addExternalImport, imports, resolveGoImport, dirFiles, goModule, goModules, goRequires } = ctx;
    const owningModule = (goModules || []).filter((item) => !item.root || fileRel === item.root || fileRel.startsWith(`${item.root}/`))
      .sort((left, right) => right.root.length - left.root.length)[0];

    // ---- symbols ----
    for (const cap of caps(grammar, `(function_declaration name: (identifier) @fn)`, tree.rootNode)) {
      const declaration = cap.node.parent;
      addSym(cap.node.text, cap.node.startPosition.row + 1, true, {
        sourceNode: declaration,
        selectionNode: cap.node,
        symbolKind: "function",
        returnType: goResultType(declaration),
      });
    }
    for (const cap of caps(grammar, `(method_declaration name: (field_identifier) @method)`, tree.rootNode)) {
      const declaration = cap.node.parent;
      const receiver = declaration.childForFieldName?.("receiver");
      const receiverDeclaration = receiver?.namedChildren?.find((child) => child.type === "parameter_declaration");
      const receiverType = goTypeName(receiverDeclaration?.childForFieldName?.("type"));
      addSym(cap.node.text, cap.node.startPosition.row + 1, true, {
        sourceNode: declaration,
        selectionNode: cap.node,
        symbolKind: "method",
        memberOf: receiverType || undefined,
        receiverType: receiverType || undefined,
        returnType: goResultType(declaration),
      });
    }
    for (const cap of caps(grammar, `(source_file (type_declaration (type_spec name: (type_identifier) @type)))`, tree.rootNode)) {
      const specification = cap.node.parent;
      const typeNode = specification.childForFieldName?.("type");
      addSym(cap.node.text, cap.node.startPosition.row + 1, false, {
        sourceNode: specification,
        selectionNode: cap.node,
        symbolKind: typeNode?.type === "interface_type" ? "interface" : "type",
        symbolSpace: "type",
        fieldTypes: goStructFields(typeNode),
      });
    }
    for (const cap of caps(grammar, `(source_file (var_declaration (var_spec name: (identifier) @var))) (source_file (const_declaration (const_spec name: (identifier) @const)))`, tree.rootNode))
      addSym(cap.node.text, cap.node.startPosition.row + 1, false, { sourceNode: cap.node.parent });

    // ---- imports: package path → package directory → all its .go files ----
    // Also record the package's local name (alias or last path segment) → dir, so cross-package `pkg.Func()`
    // selector calls can resolve in pass 2 (see internal-builder resolveCall).
    for (const cap of caps(grammar, `(import_spec) @spec`, tree.rootNode)) {
      const spec = cap.node;
      const pathNode = spec.namedChildren.find((c) => c.type === "interpreted_string_literal");
      if (!pathNode) continue;
      const importPath = pathNode.text.replace(/^["'`]|["'`]$/g, "");
      const d = resolveGoImport(importPath);
      if (!d) {
        // not a repo package: stdlib (builtin) or an external module — record for dependency analysis
        const line = pathNode.startPosition.row + 1;
        const r = goSpecToPkg(importPath, { requires: owningModule?.requires || goRequires || [], ownModule: owningModule?.module || goModule || "" });
        if (r) addExternalImport({ spec: importPath, pkg: r.pkg, builtin: r.builtin, ecosystem: "Go", kind: "go-import", line });
        else addExternalImport({ spec: importPath, kind: "go-import", line, unresolved: true }); // own-module path with no matching dir
        continue;
      }
      for (const f of dirFiles.get(d) || []) addImportEdge(f);   // Go import = whole package (all files in the dir)
      const aliasNode = spec.namedChildren.find((c) => c.type === "package_identifier");
      const local = aliasNode ? aliasNode.text : importPath.split("/").pop();
      if (local && local !== "_" && local !== ".") imports.set(local, { imported: "*", targetDir: d, goPackage: true });
    }
  },
};
