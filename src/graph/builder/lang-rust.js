// Rust extractor. Symbols: fn (incl. impl methods) + struct/enum/trait/type/mod + const/static
// (+ macro_rules!/union via optional queries). Calls: `foo()` / `x.foo()` / `path::foo()` (name only).
// File dependencies follow Rust's module tree: outlined `mod`, `use` trees, public re-exports, and anchored
// `crate/self/super` paths resolve to repo-local .rs or */mod.rs files. External crates deliberately stay out
// of this adapter; Cargo dependency analysis owns them.
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

const cleanSegment = (part) => String(part || "").trim().replace(/^r#/, "");
const pathParts = (node) => String(node?.text || "").split("::").map(cleanSegment).filter(Boolean);
const under = (node, type) => { for (let p = node?.parent; p; p = p.parent) if (p.type === type) return true; return false; };

function pathAttribute(modNode) {
  for (let prev = modNode?.previousNamedSibling; prev?.type === "attribute_item"; prev = prev.previousNamedSibling) {
    const hashedRaw = prev.text.match(/\bpath\s*=\s*r(#+)"([^"]+)"\1/);
    if (hashedRaw) return hashedRaw[2] || "";
    const plain = prev.text.match(/\bpath\s*=\s*(?:r)?"([^"]+)"/);
    if (plain) return plain[1] || "";
  }
  return "";
}

function inlineAncestors(node) {
  const result = [];
  for (let p = node?.parent; p; p = p.parent) {
    if (p.type !== "declaration_list" || p.parent?.type !== "mod_item") continue;
    const mod = p.parent;
    const name = mod.namedChildren.find((child) => child.type === "identifier")?.text;
    if (name) result.unshift({ name: cleanSegment(name), path: pathAttribute(mod) });
  }
  return result;
}

// Expand a Rust use tree into its leaf paths while retaining aliases. Examples:
// `crate::api::{self, Client as C, types::*}` -> api, api::Client, api::types.
function useLeaves(node, prefix = []) {
  if (!node) return [];
  if (node.type === "use_declaration") {
    const body = node.namedChildren.find((child) => child.type !== "visibility_modifier");
    return useLeaves(body, prefix);
  }
  if (node.type === "use_list") return node.namedChildren.flatMap((child) => useLeaves(child, prefix));
  if (node.type === "scoped_use_list") {
    const list = node.namedChildren.find((child) => child.type === "use_list");
    const head = node.namedChildren.find((child) => child !== list);
    return useLeaves(list, [...prefix, ...pathParts(head)]);
  }
  if (node.type === "use_as_clause") {
    const named = node.namedChildren;
    const alias = cleanSegment(named[named.length - 1]?.text);
    return useLeaves(named[0], prefix).map((leaf) => ({ ...leaf, local: alias }));
  }
  if (node.type === "use_wildcard") {
    return [{ segments: [...prefix, ...pathParts(node.namedChildren[0])], wildcard: true, local: null }];
  }
  if (node.type === "self") {
    const local = [...prefix].reverse().find((part) => !["crate", "self", "super"].includes(part)) || null;
    return [{ segments: prefix.length ? [...prefix] : ["self"], moduleSelf: true, local }];
  }
  if (["identifier", "scoped_identifier", "scoped_type_identifier", "crate", "super"].includes(node.type)) {
    const own = pathParts(node);
    const segments = [...prefix, ...own];
    const local = [...own].reverse().find((part) => !["crate", "self", "super"].includes(part)) || null;
    return [{ segments, local }];
  }
  return [];
}

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
    const { grammar, tree, fileRel, caps, addSym, addImportEdge, imports, resolveRustMod, resolveRustPath } = ctx;
    for (const src of [SYMS_CORE, ...SYMS_OPTIONAL]) {
      for (const cap of caps(grammar, src, tree.rootNode)) {
        addSym(cap.node.text, cap.node.startPosition.row + 1, cap.name === "method", { sourceNode: cap.node.parent });
      }
    }

    // File dependency edges are intentionally unique per source/target/relation. A qualified path can be
    // nested in another qualified path and often repeats an existing `mod`/`use`; counting occurrences would
    // inflate module coupling without adding structure.
    const emitted = new Set();
    const emit = (target, meta = {}) => {
      if (!target || target === fileRel) return;
      const relation = meta.relation || "imports";
      const key = relation + ">" + target;
      if (emitted.has(key)) return;
      emitted.add(key);
      // Rust `mod`/`use`/`pub use` relationships are resolved by the compiler. They describe real
      // architectural coupling, but they are not runtime module loading and therefore must not create
      // JavaScript-style initialization cycles or runtime boundary/blast-radius findings.
      addImportEdge(target, { ...meta, relation, compileOnly: true });
    };

    // `mod foo;` loads foo.rs or foo/mod.rs. Inline `mod foo { ... }` stays in the current file, but any
    // outlined modules declared inside it are captured separately with their inline ancestor path.
    for (const cap of caps(grammar, `(mod_item) @mod`, tree.rootNode)) {
      const mod = cap.node;
      if (mod.namedChildren.some((child) => child.type === "declaration_list")) continue;
      const name = mod.namedChildren.find((child) => child.type === "identifier")?.text;
      if (!name) continue;
      const target = resolveRustMod(fileRel, cleanSegment(name), {
        inlineModules: inlineAncestors(mod),
        explicitPath: pathAttribute(mod),
      });
      emit(target, { line: mod.startPosition.row + 1, specifier: `mod ${name}` });
    }

    // Imports/re-exports may be nested trees and aliases. Besides the file edge, retain direct item aliases
    // so the existing pass-2 call resolver can connect `use crate::worker::run; run()` across folders.
    for (const cap of caps(grammar, `(use_declaration) @use`, tree.rootNode)) {
      const use = cap.node;
      const relation = use.namedChildren.some((child) => child.type === "visibility_modifier") ? "re_exports" : "imports";
      const ancestors = inlineAncestors(use);
      for (const leaf of useLeaves(use)) {
        const resolved = resolveRustPath(fileRel, leaf.segments, { inlineModules: ancestors, unqualified: true });
        if (!resolved) continue;
        emit(resolved.targetFile, { relation, line: use.startPosition.row + 1, specifier: use.text.replace(/;\s*$/, "") });
        if (!leaf.wildcard && leaf.local && leaf.local !== "_") {
          const imported = resolved.remaining.length ? cleanSegment(resolved.remaining.at(-1)) : "*";
          imports.set(cleanSegment(leaf.local), { imported, targetFile: resolved.targetFile, rustModule: imported === "*" });
        }
      }
    }

    // Fully-qualified paths need no `use` declaration but still prove a dependency. Restrict this pass to
    // explicit crate/self/super anchors so associated paths such as `Type::method` cannot be mistaken for a
    // same-named module file. Inner prefixes are skipped; only the maximal path emits an edge.
    for (const cap of caps(grammar, `[(scoped_identifier) (scoped_type_identifier)] @path`, tree.rootNode)) {
      const node = cap.node;
      if (under(node, "use_declaration")) continue;
      if (["scoped_identifier", "scoped_type_identifier"].includes(node.parent?.type)) continue;
      const segments = pathParts(node);
      if (!["crate", "self", "super"].includes(segments[0])) continue;
      const resolved = resolveRustPath(fileRel, segments, { inlineModules: inlineAncestors(node), unqualified: false });
      if (!resolved) continue;
      emit(resolved.targetFile, { line: node.startPosition.row + 1, specifier: node.text });
      const finalName = cleanSegment(segments.at(-1));
      if (resolved.remaining.length && finalName && !imports.has(finalName)) {
        imports.set(finalName, { imported: finalName, targetFile: resolved.targetFile, rustQualified: true });
      }
    }
  },
};
