// C# extractor. Symbols: class/interface/struct/enum (+record/delegate via optional queries) +
// method/constructor + properties/fields. Calls: `Foo()` / `x.Foo()` (name only). Heritage: base_list
// (C# merges extends+implements into one list). `using` directives name NAMESPACES, not files, and a
// namespace maps to a file only by convention — so no import edges are attempted; cross-file
// connectivity comes from the name-based calls pass, same as the other non-JS languages.
const SYMS_CORE = `
  (class_declaration name: (identifier) @class)
  (interface_declaration name: (identifier) @class)
  (struct_declaration name: (identifier) @class)
  (enum_declaration name: (identifier) @class)
  (method_declaration name: (identifier) @method)
  (constructor_declaration name: (identifier) @method)
  (property_declaration name: (identifier) @field)`;
// Grammar-version-dependent node types, compiled SEPARATELY: one unknown node type voids the whole
// query it appears in, so these must never ride along with SYMS_CORE.
const SYMS_OPTIONAL = [
  `(record_declaration name: (identifier) @class)`,
  `(delegate_declaration name: (identifier) @method)`,
  `(field_declaration (variable_declaration (variable_declarator (identifier) @field)))`,
];

export default {
  family: "csharp",
  grammars: ["c_sharp"],
  exts: { ".cs": "c_sharp" },
  isWeb: false,
  calls: `
    (invocation_expression function: (identifier) @callee)
    (invocation_expression function: (member_access_expression name: (identifier) @callee))`,
  heritage: [`(base_list (identifier) @super)`, `(base_list (generic_name (identifier) @super))`],

  pass1(ctx) {
    const { grammar, tree, caps, addSym } = ctx;
    for (const src of [SYMS_CORE, ...SYMS_OPTIONAL]) {
      for (const cap of caps(grammar, src, tree.rootNode)) {
        addSym(cap.node.text, cap.node.startPosition.row + 1, cap.name === "method", { sourceNode: cap.node.parent });
      }
    }
  },
};
