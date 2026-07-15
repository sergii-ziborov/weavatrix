// Java extractor. Keeps file-level imports/calls while modelling the Java ownership and type system:
// classes/interfaces/enums/records own their methods, heritage distinguishes extends from implements,
// and project-local type references resolve to the declaration node (never to synthetic type-name nodes).
const TYPE_CORE = `
  (class_declaration name: (identifier) @class)
  (interface_declaration name: (identifier) @interface)
  (enum_declaration name: (identifier) @enum)`;
// Keep grammar-version-dependent declarations separate: one unknown node type invalidates a whole query.
const TYPE_OPTIONAL = [
  `(record_declaration name: (identifier) @record)`,
  `(annotation_type_declaration name: (identifier) @annotation)`,
];
const MEMBERS = `
  (method_declaration name: (identifier) @method)
  (constructor_declaration name: (identifier) @constructor)
  (field_declaration declarator: (variable_declarator name: (identifier) @field))`;

const TYPE_DECLARATIONS = new Set([
  "class_declaration", "interface_declaration", "enum_declaration",
  "record_declaration", "annotation_type_declaration",
]);
const FIELD_DECLARATIONS = new Set(["field_declaration"]);

const ancestor = (node, accepted) => {
  let current = node?.parent;
  for (let hops = 0; current && hops < 12; hops++, current = current.parent) {
    if (accepted.has(current.type)) return current;
  }
  return null;
};

const visibilityOf = (declaration, owner) => {
  const modifiers = declaration?.namedChildren?.find((node) => node.type === "modifiers")?.text || "";
  if (/\bprivate\b/.test(modifiers)) return "private";
  if (/\bprotected\b/.test(modifiers)) return "protected";
  if (/\bpublic\b/.test(modifiers)) return "public";
  if (["interface_declaration", "annotation_type_declaration"].includes(owner?.type)) return "public";
  return "package";
};

const lineOf = (node) => node.startPosition.row + 1;
const symbolBaseId = (fileRel, nameNode) => `${fileRel}#${nameNode.text}@${lineOf(nameNode)}`;
const declarationKey = (node) => `${node?.startIndex ?? -1}:${node?.endIndex ?? -1}`;
const exactJavaTarget = (resolveJavaImport, parts) => {
  const target = resolveJavaImport(parts);
  const suffix = parts.join("/") + ".java";
  return target && (target === suffix || target.endsWith("/" + suffix)) ? target : null;
};

export default {
  family: "java",
  grammars: ["java"],
  exts: { ".java": "java" },
  isWeb: false,
  calls: `(method_invocation name: (identifier) @callee)`,
  // Capturing the base type_identifier (rather than the whole generic/scoped type) gives the shared
  // resolver the imported/local declaration name. Each query is deliberately non-overlapping.
  heritage: [
    { relation: "inherits", query: `(superclass (type_identifier) @super)` },
    { relation: "inherits", query: `(superclass (generic_type (type_identifier) @super))` },
    { relation: "inherits", query: `(superclass (scoped_type_identifier name: (type_identifier) @super))` },
    { relation: "inherits", query: `(superclass (generic_type (scoped_type_identifier name: (type_identifier) @super)))` },
    { relation: "inherits", query: `(extends_interfaces (type_list (type_identifier) @super))` },
    { relation: "inherits", query: `(extends_interfaces (type_list (generic_type (type_identifier) @super)))` },
    { relation: "inherits", query: `(extends_interfaces (type_list (scoped_type_identifier name: (type_identifier) @super)))` },
    { relation: "inherits", query: `(extends_interfaces (type_list (generic_type (scoped_type_identifier name: (type_identifier) @super))))` },
    { relation: "implements", query: `(super_interfaces (type_list (type_identifier) @super))` },
    { relation: "implements", query: `(super_interfaces (type_list (generic_type (type_identifier) @super)))` },
    { relation: "implements", query: `(super_interfaces (type_list (scoped_type_identifier name: (type_identifier) @super)))` },
    { relation: "implements", query: `(super_interfaces (type_list (generic_type (scoped_type_identifier name: (type_identifier) @super))))` },
  ],

  pass1(ctx) {
    const {
      grammar, tree, fileRel, caps, field, addSym, addImportEdge, imports,
      resolveJavaImport, fileSet, links, nodeIds,
    } = ctx;
    const ownerIds = new Map();
    const addJavaSym = (nameNode, callable, extra) => {
      const base = symbolBaseId(fileRel, nameNode);
      // Compact/generated Java can put an owner, constructor and overloads with the same name on one
      // line. Preserve historical IDs normally; disambiguate only an actual collision by source column.
      const id = nodeIds.has(base) ? `${base}:c${nameNode.startPosition.column + 1}` : base;
      addSym(nameNode.text, lineOf(nameNode), callable, {
        ...extra,
        ...(id === base ? {} : { idSuffix: id.slice(base.length) }),
      });
      return nodeIds.has(id) ? id : null;
    };

    // Add owners first even though tree-sitter captures are source-ordered. This makes ownership edges
    // deterministic for nested types and methods declared before/after other nested declarations.
    for (const src of [TYPE_CORE, ...TYPE_OPTIONAL]) {
      for (const cap of caps(grammar, src, tree.rootNode)) {
        const declaration = cap.node.parent;
        const id = addJavaSym(cap.node, false, {
          sourceNode: cap.node.parent,
          symbolKind: cap.name,
        });
        if (id) ownerIds.set(declarationKey(declaration), id);
      }
    }

    for (const cap of caps(grammar, MEMBERS, tree.rootNode)) {
      const declaration = cap.name === "field" ? ancestor(cap.node, FIELD_DECLARATIONS) : cap.node.parent;
      const owner = ancestor(cap.node, TYPE_DECLARATIONS);
      const ownerNameNode = owner && field(owner, "name");
      const memberKind = cap.name === "constructor" ? "constructor" : cap.name;
      const memberId = addJavaSym(cap.node, cap.name !== "field", {
        sourceNode: declaration,
        symbolKind: memberKind,
        ...(ownerNameNode ? { memberOf: ownerNameNode.text } : {}),
        visibility: visibilityOf(declaration, owner),
      });
      if (!ownerNameNode || cap.name === "field") continue;
      const ownerId = ownerIds.get(declarationKey(owner));
      if (ownerId && memberId && ownerId !== memberId) {
        links.push({ source: ownerId, target: memberId, relation: "method", confidence: "EXTRACTED" });
      }
    }

    const wildcardPackages = [];
    const staticWildcardTargets = [];
    const importStatements = caps(grammar, `(import_declaration) @imp`, tree.rootNode);
    for (const cap of importStatements) {
      const match = cap.node.text.match(/^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;?\s*$/);
      if (!match) continue;
      const isStatic = !!match[1];
      const parts = match[2].split(".").filter(Boolean);
      const wildcard = !!match[3];
      const line = lineOf(cap.node);
      if (!isStatic && wildcard) {
        wildcardPackages.push(parts);
        continue;
      }
      if (!isStatic) {
        const target = exactJavaTarget(resolveJavaImport, parts);
        if (!target) continue;
        const local = parts[parts.length - 1];
        addImportEdge(target, { line, specifier: parts.join("."), compileOnly: true });
        imports.set(local, { imported: local, targetFile: target });
        continue;
      }

      // Static imports end in a member name. Walk prefixes until the declaring project class resolves.
      let target = null; let classParts = null;
      const max = wildcard ? parts.length : parts.length - 1;
      for (let take = max; take > 0 && !target; take--) {
        const candidate = parts.slice(0, take);
        target = exactJavaTarget(resolveJavaImport, candidate);
        if (target) classParts = candidate;
      }
      if (!target) continue;
      addImportEdge(target, { line, specifier: `${isStatic ? "static " : ""}${parts.join(".")}${wildcard ? ".*" : ""}`, compileOnly: true });
      if (wildcard) staticWildcardTargets.push(target);
      else {
        const member = parts[classParts.length];
        if (member) imports.set(member, { imported: member, targetFile: target });
      }
    }

    // Seed the shared pass-2 resolver with Java's implicit same-package types and wildcard imports.
    // Exact-path validation is important: the general basename fallback is useful for explicit imports,
    // but must not bind an unimported Foo to an unrelated package's Foo.java.
    const slash = fileRel.lastIndexOf("/");
    const ownDir = slash < 0 ? "" : fileRel.slice(0, slash);
    const bindType = (name) => {
      if (!name || imports.has(name)) return;
      const samePackage = `${ownDir ? ownDir + "/" : ""}${name}.java`;
      if (fileSet.has(samePackage)) {
        imports.set(name, { imported: name, targetFile: samePackage });
        return;
      }
      for (const pkg of wildcardPackages) {
        const target = exactJavaTarget(resolveJavaImport, [...pkg, name]);
        if (target) { imports.set(name, { imported: name, targetFile: target }); return; }
      }
    };
    for (const cap of caps(grammar, `(type_identifier) @type`, tree.rootNode)) bindType(cap.node.text);
    for (const cap of caps(grammar, `(scoped_type_identifier) @type`, tree.rootNode)) {
      const parts = cap.node.text.split(".").filter(Boolean);
      const target = exactJavaTarget(resolveJavaImport, parts);
      const name = parts[parts.length - 1];
      if (target && name && !imports.has(name)) imports.set(name, { imported: name, targetFile: target });
    }
    if (staticWildcardTargets.length === 1) {
      for (const cap of caps(grammar, `(method_invocation name: (identifier) @callee)`, tree.rootNode)) {
        if (!imports.has(cap.node.text)) imports.set(cap.node.text, { imported: cap.node.text, targetFile: staticWildcardTargets[0] });
      }
    }
  },
};
