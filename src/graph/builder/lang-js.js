// JS / TS / JSX / TSX extractor for the built-in graph builder.
// Symbols: functions, generators, classes, methods, top-level const/let/var (data + arrow/fn consts).
// Imports: ESM `import`, CJS `require`, path-aliases (tsconfig/vite), and barrel re-exports (`export … from`).
// Calls: bare `foo()`. Heritage: `class X extends Y`. Everything runs through the shared ctx (see internal-builder.js).
const CALLABLE = /arrow_function|function|function_expression|generator_function/;

const FUNCS = `
  (function_declaration name: (identifier) @fn)
  (generator_function_declaration name: (identifier) @fn)
  (class_declaration name: (_) @class)
  (method_definition name: (_) @method)`;
const TOPVARS = `
  (program (lexical_declaration (variable_declarator) @decl))
  (program (variable_declaration (variable_declarator) @decl))
  (program (export_statement (lexical_declaration (variable_declarator) @decl)))
  (program (export_statement (variable_declaration (variable_declarator) @decl)))`;
const REQUIRE = `(variable_declarator name: (_) @lhs value: (call_expression function: (identifier) @req arguments: (arguments (string (string_fragment) @src))))`;

function parseExportSpecifiers(raw) {
  return String(raw || "").split(",").map((part) => {
    const text = part.trim();
    const typeOnly = /^type\s+/.test(text);
    const clean = text.replace(/^type\s+/, "").trim();
    const match = clean.match(/^([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*|default))?$/);
    return match ? { imported: match[1], exported: match[2] || match[1], typeOnly } : null;
  }).filter(Boolean);
}

export default {
  family: "js",
  grammars: ["javascript", "typescript", "tsx"],
  exts: { ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "tsx" },
  isWeb: false,
  calls: `(call_expression function: (identifier) @callee)`,
  heritage: [`(class_heritage (identifier) @super)`, `(class_heritage (extends_clause value: (identifier) @super))`],

  pass1(ctx) {
    const { grammar, tree, fileRel, caps, field, addSym, addImportEdge, addExternalImport, markExported, imports, resolveJsImport, resolveAlias } = ctx;
    const recordJsExport = typeof ctx.recordJsExport === "function" ? ctx.recordJsExport : () => {};
    // exported-ness of a declaration = an export_statement ancestor (export function/class/const …).
    // BOUNDED climb: web-tree-sitter's node.parent is O(depth) (re-walks a cursor from the root each call),
    // so an UNBOUNDED walk to `program` for every symbol was O(depth^3) and HUNG the build for minutes/hours
    // on deeply-nested / minified / bundled JS (regression). An export_statement is always a NEAR ancestor of
    // the declaration head (≤ ~5 hops), and hitting a statement_block means we're nested inside a function →
    // not a module-level export → bail immediately. See [[graph-builder-internalization]].
    // Early-out for nested scopes keeps this O(1); class members are intentionally never module exports even
    // when their owner class is exported. The hop cap remains a backstop for malformed/deep syntax trees.
    const exportStatementOf = (node) => {
      let p = node.parent;
      for (let hops = 0; p && hops < 6; hops++) {
        if (p.type === "export_statement") return p;
        if (p.type === "program" || p.type === "statement_block" || p.type === "class_body") return null;
        p = p.parent;
      }
      return null;
    };
    const isExportedDecl = (node) => !!exportStatementOf(node);
    const isModuleDeclaration = (node) => {
      let p = node.parent;
      for (let hops = 0; p && hops < 8; hops++) {
        if (p.type === "program") return true;
        if (p.type === "statement_block" || p.type === "class_body") return false;
        p = p.parent;
      }
      return false;
    };
    // a bare (package) specifier = non-relative AND not a path alias; alias-that-missed is a broken local, not a dep
    const isBareSpec = (spec) => !!spec && !spec.startsWith(".") && resolveAlias(fileRel, spec) == null;
    // broken local import (relative or alias path resolving to no file) — recorded for the "unresolved-import"
    // finding. Asset imports (svg/css-modules-adjacent/fonts/…) and ?query-suffixed specs that resolve once
    // the query is stripped (Vite ?raw/?url/?worker) are NOT code-graph concerns.
    const ASSET_RE = /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|eot|otf|mp[34]|webm|wasm|pdf|txt|md|html?)$/i;
    const recordUnresolved = (rawSpec, kind, line, typeOnly = false) => {
      const clean = String(rawSpec || "").split("?")[0];
      if (!clean || ASSET_RE.test(clean)) return;
      if (clean !== rawSpec && resolveJsImport(fileRel, clean)) return; // only the ?query broke resolution
      addExternalImport({ spec: rawSpec, kind, line, unresolved: true, typeOnly });
    };

    // ---- symbols (export flag captured at declaration time) ----
    const methodMetadata = (nameNode) => {
      let method = nameNode.parent;
      while (method && method.type !== "method_definition") method = method.parent;
      let owner = method?.parent;
      while (owner && !["class_declaration", "class"].includes(owner.type)) owner = owner.parent;
      const ownerName = owner && field(owner, "name")?.text;
      const visibility = /^\s*private\b/.test(method?.text || "") ? "private"
        : /^\s*protected\b/.test(method?.text || "") ? "protected" : "public";
      return { symbolKind: "method", ...(ownerName ? { memberOf: ownerName } : {}), visibility };
    };
    for (const cap of caps(grammar, FUNCS, tree.rootNode)) {
      const isMethod = cap.name === "method";
      const exportStatement = !isMethod && exportStatementOf(cap.node);
      addSym(cap.node.text, cap.node.startPosition.row + 1, cap.name !== "class", {
        sourceNode: cap.node.parent,
        selectionNode: cap.node,
        ...(exportStatement ? { exported: true } : {}),
        ...(isMethod ? methodMetadata(cap.node) : { symbolKind: cap.name === "class" ? "class" : "function", moduleDeclaration: isModuleDeclaration(cap.node) })
      });
      if (exportStatement) {
        recordJsExport({
          kind: "local",
          exported: /^\s*export\s+default\b/.test(exportStatement.text) ? "default" : cap.node.text,
          local: cap.node.text,
          typeOnly: false,
        });
      }
    }
    for (const cap of caps(grammar, TOPVARS, tree.rootNode)) {
      const nameNode = field(cap.node, "name"); if (!nameNode || nameNode.type !== "identifier") continue;
      const val = field(cap.node, "value");
      const exported = isExportedDecl(cap.node);
      addSym(nameNode.text, nameNode.startPosition.row + 1, !!(val && CALLABLE.test(val.type)), {
        sourceNode: val || cap.node,
        selectionNode: nameNode,
        ...(exported ? { exported: true } : {}),
        symbolKind: "variable",
        moduleDeclaration: true
      });
      if (exported) recordJsExport({ kind: "local", exported: nameNode.text, local: nameNode.text, typeOnly: false });
    }

    const importTypeOnly = (node) => {
      if (/^\s*import\s+type\b/.test(node.text)) return true;
      const clause = node.namedChildren.find((c) => c.type === "import_clause");
      if (!clause) return false; // side-effect import executes the target module
      const parts = clause.namedChildren;
      if (parts.some((c) => c.type === "identifier" || c.type === "namespace_import")) return false;
      const named = parts.find((c) => c.type === "named_imports");
      const specs = named?.namedChildren.filter((c) => c.type === "import_specifier") || [];
      return specs.length > 0 && specs.every((s) => /^\s*type\b/.test(s.text));
    };
    const reexportTypeOnly = (node) => {
      if (/^\s*export\s+type\b/.test(node.text)) return true;
      const clause = node.namedChildren.find((c) => c.type === "export_clause");
      const specs = clause?.namedChildren.filter((c) => c.type === "export_specifier") || [];
      return specs.length > 0 && specs.every((s) => /^\s*type\b/.test(s.text));
    };

    // ---- ESM imports ----
    for (const cap of caps(grammar, `(import_statement) @imp`, tree.rootNode)) {
      const node = cap.node; const srcNode = field(node, "source");
      const rawSpec = srcNode ? srcNode.text.replace(/^['"`]|['"`]$/g, "") : "";
      const line = node.startPosition.row + 1;
      const typeOnly = importTypeOnly(node);
      const tgt = resolveJsImport(fileRel, rawSpec);
      if (!tgt) {
        if (isBareSpec(rawSpec)) addExternalImport({ spec: rawSpec, kind: "esm", line, typeOnly });
        else if (rawSpec) recordUnresolved(rawSpec, "esm", line, typeOnly);
        continue;
      }
      addImportEdge(tgt, { typeOnly, line, specifier: rawSpec });
      const clause = node.namedChildren.find((c) => c.type === "import_clause"); if (!clause) continue;
      for (const c of clause.namedChildren) {
        if (c.type === "identifier") imports.set(c.text, { imported: "default", targetFile: tgt, typeOnly, line, specifier: rawSpec });
        else if (c.type === "namespace_import") { const id = c.namedChildren.find((x) => x.type === "identifier"); if (id) imports.set(id.text, { imported: "*", targetFile: tgt, typeOnly, line, specifier: rawSpec }); }
        else if (c.type === "named_imports") for (const s of c.namedChildren) { if (s.type !== "import_specifier") continue; const nm = field(s, "name"), al = field(s, "alias"); if (nm) imports.set((al || nm).text, { imported: nm.text, targetFile: tgt, typeOnly: typeOnly || /^\s*type\b/.test(s.text), line, specifier: rawSpec }); }
      }
    }

    // ---- CJS require (declarator form: local bindings + import edges) ----
    for (const cap of caps(grammar, REQUIRE, tree.rootNode)) {
      if (cap.name !== "src") continue;
      let dv = cap.node; while (dv && dv.type !== "variable_declarator") dv = dv.parent;
      const tgt = resolveJsImport(fileRel, cap.node.text); if (!tgt) continue;
      addImportEdge(tgt, { typeOnly: false, line: cap.node.startPosition.row + 1, specifier: cap.node.text });
      const lhs = dv && field(dv, "name");
      if (lhs && lhs.type === "identifier") imports.set(lhs.text, { imported: "*", targetFile: tgt, line: cap.node.startPosition.row + 1, specifier: cap.node.text });
      else if (lhs && lhs.type === "object_pattern") for (const p of lhs.namedChildren) { const key = field(p, "key") || (p.type === "shorthand_property_identifier_pattern" ? p : null); const val = field(p, "value"); const local = (val && val.type === "identifier") ? val : key; if (key && local) imports.set(local.text, { imported: key.text, targetFile: tgt, line: cap.node.startPosition.row + 1, specifier: cap.node.text }); }
    }

    // ---- CJS require, ALL forms (side-effect require("dotenv/config") included): bare-pkg records +
    // non-literal require(x) → dynamic marker so dep analysis can suppress false "unused" positives ----
    for (const cap of caps(grammar, `(call_expression function: (identifier) @fn)`, tree.rootNode)) {
      if (cap.node.text !== "require") continue;
      const call = cap.node.parent; const args = field(call, "arguments");
      const arg = args && args.namedChildren ? args.namedChildren[0] : null;
      const line = call.startPosition.row + 1;
      if (arg && arg.type === "string") {
        const rawSpec = arg.text.replace(/^['"`]|['"`]$/g, "");
        if (resolveJsImport(fileRel, rawSpec)) continue;
        if (isBareSpec(rawSpec)) addExternalImport({ spec: rawSpec, kind: "cjs", line });
        else recordUnresolved(rawSpec, "cjs", line);
      } else {
        addExternalImport({ dynamic: true, kind: "cjs", line });
      }
    }

    // ---- dynamic import(): literal bare → package record; literal local → dynamic marker with target;
    // non-literal → bare dynamic marker ----
    for (const cap of caps(grammar, `(call_expression function: (import) @imp)`, tree.rootNode)) {
      const call = cap.node.parent; const args = field(call, "arguments");
      const arg = args && args.namedChildren ? args.namedChildren[0] : null;
      const line = call.startPosition.row + 1;
      if (arg && arg.type === "string") {
        const rawSpec = arg.text.replace(/^['"`]|['"`]$/g, "");
        const tgt = resolveJsImport(fileRel, rawSpec);
        if (tgt) addExternalImport({ dynamic: true, spec: rawSpec, target: tgt, kind: "dynamic", line });
        else if (isBareSpec(rawSpec)) addExternalImport({ spec: rawSpec, kind: "dynamic", line });
        else if (rawSpec) recordUnresolved(rawSpec, "dynamic", line);
      } else {
        addExternalImport({ dynamic: true, kind: "dynamic", line });
      }
    }

    // ---- re-exports (barrel/index files): edge so the real target isn't falsely DEAD; bare source → external ----
    for (const cap of caps(grammar, `(export_statement) @exp`, tree.rootNode)) {
      const node = cap.node; const srcNode = field(node, "source");
      if (!srcNode) continue;
      const rawSpec = srcNode.text.replace(/^['"`]|['"`]$/g, "");
      const line = node.startPosition.row + 1;
      const typeOnly = reexportTypeOnly(node);
      const tgt = resolveJsImport(fileRel, rawSpec);
      if (tgt) {
        addImportEdge(tgt, { relation: "re_exports", typeOnly, line, specifier: rawSpec });
        const text = node.text.trim();
        const star = text.match(/^export\s+(type\s+)?\*\s+from\b/);
        const namespace = text.match(/^export\s+(type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/);
        const clause = text.match(/^export\s+(type\s+)?\{([\s\S]*?)\}\s+from\b/);
        if (namespace) {
          recordJsExport({ kind: "namespace", exported: namespace[2], targetFile: tgt, typeOnly: !!namespace[1] });
        } else if (star) {
          recordJsExport({ kind: "star", targetFile: tgt, typeOnly: !!star[1] });
        } else if (clause) {
          for (const spec of parseExportSpecifiers(clause[2])) {
            recordJsExport({ kind: "named", exported: spec.exported, imported: spec.imported, targetFile: tgt, typeOnly: !!clause[1] || spec.typeOnly });
          }
        }
      }
      else if (isBareSpec(rawSpec)) addExternalImport({ spec: rawSpec, kind: "reexport", line, typeOnly });
      else if (rawSpec) recordUnresolved(rawSpec, "reexport", line, typeOnly);
    }

    // Local aliases (`export { internal as publicName }`) and default identifiers are part of the
    // same export table used by the post-pass barrel resolver. Sourced clauses were recorded above.
    for (const cap of caps(grammar, `(export_statement) @exp`, tree.rootNode)) {
      const node = cap.node;
      if (field(node, "source")) continue;
      const text = node.text.trim();
      const clause = text.match(/^export\s+(type\s+)?\{([\s\S]*?)\}/);
      if (clause) for (const spec of parseExportSpecifiers(clause[2])) {
        recordJsExport({ kind: "local", exported: spec.exported, local: spec.imported, typeOnly: !!clause[1] || spec.typeOnly });
      }
      const identifierDefault = text.match(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?$/);
      if (identifierDefault) recordJsExport({ kind: "local", exported: "default", local: identifierDefault[1], typeOnly: false });
      const typedDeclaration = text.match(/^export\s+(?:declare\s+)?(type|interface|enum)\s+([A-Za-z_$][\w$]*)\b/);
      if (typedDeclaration) recordJsExport({
        kind: "local",
        exported: typedDeclaration[2],
        local: typedDeclaration[2],
        typeOnly: typedDeclaration[1] !== "enum",
      });
      const defaultValue = field(node, "value");
      if (defaultValue?.type === "object") {
        // Service facades commonly expose local helpers through `export default { getSchema,
        // save: persist }`. Record the public member -> local binding instead of treating the
        // object as an opaque default export.
        recordJsExport({kind: "facade-root", exported: "default", local: "default", typeOnly: false});
        for (const property of defaultValue.namedChildren || []) {
          if (["shorthand_property_identifier", "shorthand_property_identifier_pattern"].includes(property.type)) {
            recordJsExport({kind: "facade-member", member: property.text, local: property.text, typeOnly: false});
            markExported(property.text);
            continue;
          }
          if (property.type !== "pair") continue;
          const key = field(property, "key");
          const value = field(property, "value");
          if (!key || value?.type !== "identifier") continue;
          const member = key.text.replace(/^['"`]|['"`]$/g, "");
          if (!/^[A-Za-z_$][\w$]*$/.test(member)) continue;
          recordJsExport({kind: "facade-member", member, local: value.text, typeOnly: false});
          markExported(value.text);
        }
      }
    }

    // ---- export markers beyond declarations: `export { a, b }`, `export default X`, CJS module.exports ----
    for (const cap of caps(grammar, `(export_statement (export_clause (export_specifier name: (identifier) @n)))`, tree.rootNode)) {
      let st = cap.node.parent; while (st && st.type !== "export_statement") st = st.parent;
      if (st && !field(st, "source")) markExported(cap.node.text); // with a source it's a re-export, not a local symbol
    }
    for (const cap of caps(grammar, `(export_statement value: (identifier) @def)`, tree.rootNode)) markExported(cap.node.text);
    for (const cap of caps(grammar, `(assignment_expression left: (member_expression) @lhs right: (identifier) @rhs)`, tree.rootNode)) {
      if (cap.name !== "rhs") continue;
      const lhs = field(cap.node.parent, "left"); const l = lhs ? lhs.text : "";
      if (l === "module.exports" || l.startsWith("exports.") || l.startsWith("module.exports.")) markExported(cap.node.text);
    }
    for (const cap of caps(grammar, `(assignment_expression left: (member_expression) right: (object (shorthand_property_identifier) @p))`, tree.rootNode)) {
      let ae = cap.node.parent; while (ae && ae.type !== "assignment_expression") ae = ae.parent;
      const lhs = ae && field(ae, "left");
      if (lhs && (lhs.text === "module.exports" || lhs.text.startsWith("exports."))) markExported(cap.node.text);
    }
  },
};
