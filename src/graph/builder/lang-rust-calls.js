// Rust scoped-call resolution (`Path::method()`), split from lang-rust.js. Resolved with the full
// qualifier in hand so an external associated function (`OpenOptions::new()`, `Vec::from()`) never binds
// its bare final name to an unrelated same-named function in the directory. Only heads with real evidence
// produce an edge: crate/self/super anchors, `use`-bound names (including sibling-crate modules),
// fully-qualified sibling crates, and local types whose exact impl method is indexed. A std/external
// type head is left unresolved on purpose.

// Symbol kinds that can own an associated function via `Type::method`.
const TYPE_KINDS = new Set(["struct", "enum", "trait", "type", "union"]);

// `pathParts` and `inlineAncestors` stay owned by lang-rust.js (pass 1 uses them too) and are passed in,
// so this module never imports back from lang-rust.js.
export function rustScopedCalls(ctx, { pathParts, inlineAncestors }) {
  const { grammar, tree, fileRel, caps, enclosing, links, nodeById, importedLocals,
          dirSymbols, resolveNamedSymbol, resolveRustMethod, resolveRustPath, resolveRustCratePath } = ctx;
  const dir = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : "";
  const localSyms = dirSymbols?.get(dir);
  const emitCall = (node, target) => {
    const caller = enclosing(fileRel, node.startPosition.row + 1);
    if (caller && target && target !== caller.id) {
      links.push({ source: caller.id, target, relation: "calls", confidence: "INFERRED", line: node.startPosition.row + 1 });
    }
  };
  for (const cap of caps(grammar, `(call_expression function: (scoped_identifier) @path)`, tree.rootNode)) {
    const node = cap.node;
    const segments = pathParts(node);
    if (segments.length < 2) continue;
    const head = segments[0];
    const method = segments.at(-1);

    if (["crate", "self", "super"].includes(head)) {
      const resolved = resolveRustPath(fileRel, segments, { inlineModules: inlineAncestors(node), unqualified: false });
      if (resolved) emitCall(node, resolveNamedSymbol(resolved.targetFile, method, "value"));
      continue;
    }

    const bound = importedLocals?.get(fileRel)?.get(head);
    if (bound?.targetFile) {
      emitCall(node, resolveNamedSymbol(bound.targetFile, method, "value"));
      continue;
    }

    const crateResolved = resolveRustCratePath ? resolveRustCratePath(head, segments.slice(1, -1)) : null;
    if (crateResolved) {
      emitCall(node, resolveNamedSymbol(crateResolved.targetFile, method, "value"));
      continue;
    }

    // Local type's associated function: resolve the exact impl member. Nothing else (enum-variant
    // construction, external types) has an indexed target, so it produces no edge.
    const headId = localSyms?.get(head);
    if (headId && TYPE_KINDS.has(nodeById.get(headId)?.symbol_kind)) {
      emitCall(node, resolveRustMethod(dir, head, method));
      continue;
    }

    // Head is a locally-declared outlined module used without `use` (`mod utils; utils::init()`), the
    // dominant flat-file idiom. resolveRustPath matches only a REAL repo module file, so an external type
    // head (OpenOptions, Vec) resolves to null and still produces no edge — no dir-scope mis-binding.
    const modResolved = resolveRustPath?.(fileRel, segments.slice(0, -1), { inlineModules: inlineAncestors(node), unqualified: true });
    if (modResolved) emitCall(node, resolveNamedSymbol(modResolved.targetFile, method, "value"));
  }
}
