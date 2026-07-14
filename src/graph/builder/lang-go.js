// Go extractor. Symbols: func/method(receiver)/type(struct+interface)/top-level var+const.
// Imports: `import "mod/pkg"` → the package DIRECTORY's files (Go package = dir), resolved via go.mod prefix.
// Unresolved paths are RECORDED as external imports (stdlib → builtin, modules → ecosystem "Go") so
// dependency analysis can diff them against go.mod. Calls: bare `foo()` (same-file + same-package resolve
// in the orchestrator; cross-pkg `pkg.Func()` is a selector — see resolveGoPackage/pass2). No inheritance.
import { goSpecToPkg } from "./spec-pkg.js";

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
    const { grammar, tree, fileRel, caps, addSym, addImportEdge, addExternalImport, imports, resolveGoImport, dirFiles, goModule, goRequires } = ctx;

    // ---- symbols ----
    for (const cap of caps(grammar, `(function_declaration name: (identifier) @fn) (method_declaration name: (field_identifier) @method)`, tree.rootNode))
      addSym(cap.node.text, cap.node.startPosition.row + 1, true, { sourceNode: cap.node.parent });
    for (const cap of caps(grammar, `(source_file (type_declaration (type_spec name: (type_identifier) @type)))`, tree.rootNode))
      addSym(cap.node.text, cap.node.startPosition.row + 1, false, { sourceNode: cap.node.parent });
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
        const r = goSpecToPkg(importPath, { requires: goRequires || [], ownModule: goModule || "" });
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
