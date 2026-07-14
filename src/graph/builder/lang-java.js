// Java extractor. Symbols: class/interface/enum + method/constructor + fields.
// Imports: `import a.b.C;` → the C.java file (package path = dir; suffix-matched). Calls: `x.method()` /
// `method()` (name only). Heritage: `extends` + `implements`.
const SYMS = `
  (class_declaration name: (identifier) @class)
  (interface_declaration name: (identifier) @class)
  (enum_declaration name: (identifier) @class)
  (method_declaration name: (identifier) @method)
  (constructor_declaration name: (identifier) @method)
  (field_declaration declarator: (variable_declarator name: (identifier) @field))`;

export default {
  family: "java",
  grammars: ["java"],
  exts: { ".java": "java" },
  isWeb: false,
  calls: `(method_invocation name: (identifier) @callee)`,
  heritage: [`(superclass (type_identifier) @super)`, `(super_interfaces (type_list (type_identifier) @super))`],

  pass1(ctx) {
    const { grammar, tree, caps, addSym, addImportEdge, imports, resolveJavaImport } = ctx;
    for (const cap of caps(grammar, SYMS, tree.rootNode)) addSym(cap.node.text, cap.node.startPosition.row + 1, cap.name === "method", { sourceNode: cap.node.parent });
    for (const cap of caps(grammar, `(import_declaration (scoped_identifier) @imp)`, tree.rootNode)) {
      const parts = cap.node.text.split("."); const cls = parts[parts.length - 1];
      const tgt = resolveJavaImport(parts); if (!tgt) continue;
      addImportEdge(tgt); imports.set(cls, { imported: "*", targetFile: tgt });
    }
  },
};
