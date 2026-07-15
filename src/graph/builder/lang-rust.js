// Rust extractor. Symbols: fn (incl. impl methods) + struct/enum/trait/type/mod + const/static
// (+ macro_rules!/union via optional queries). Calls: `foo()` / `x.foo()` / `path::foo()` (name only).
// Heritage: `impl Trait for Type` resolves only when the impl block sits inside a tracked symbol
// (e.g. a mod) — a top-level impl has no enclosing symbol to anchor the edge, so v1 usually skips it.
// `use` paths map to files only through the crate's module tree, which needs Cargo layout resolution —
// no import edges in v1; cross-file connectivity comes from the name-based calls pass plus the
// same-folder scope (mod.rs convention).
const SYMS_CORE = `
  (function_item name: (identifier) @method)
  (struct_item name: (type_identifier) @class)
  (enum_item name: (type_identifier) @class)
  (trait_item name: (type_identifier) @class)
  (type_item name: (type_identifier) @class)
  (mod_item name: (identifier) @class)
  (const_item name: (identifier) @field)
  (static_item name: (identifier) @field)`;
// Grammar-version-dependent node types, compiled SEPARATELY (one unknown type voids its whole query).
const SYMS_OPTIONAL = [
  `(macro_definition name: (identifier) @method)`,
  `(union_item name: (type_identifier) @class)`,
];

export default {
  family: "rust",
  grammars: ["rust"],
  exts: { ".rs": "rust" },
  isWeb: false,
  calls: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (field_expression field: (field_identifier) @callee))
    (call_expression function: (scoped_identifier name: (identifier) @callee))`,
  heritage: [
    `(impl_item trait: (type_identifier) @super)`,
    `(impl_item trait: (generic_type type: (type_identifier) @super))`,
  ],

  pass1(ctx) {
    const { grammar, tree, caps, addSym } = ctx;
    for (const src of [SYMS_CORE, ...SYMS_OPTIONAL]) {
      for (const cap of caps(grammar, src, tree.rootNode)) {
        addSym(cap.node.text, cap.node.startPosition.row + 1, cap.name === "method", { sourceNode: cap.node.parent });
      }
    }
  },
};
