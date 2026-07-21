// Solidity extractor. Symbols: contract/interface/library (space "both" so `is Base` heritage and
// `new Vault()` both resolve through the value-space resolver), functions/constructors/modifiers/
// events/errors/structs/enums/state vars (members carry memberOf + visibility). Imports: relative
// paths, Foundry remappings (remappings.txt / foundry.toml), and root-anchored specs resolve to repo
// files; everything else (npm-style @openzeppelin/…, absent lib/ submodules) is RECORDED as an
// external import for dependency analysis. Calls: bare `f()`, modifier invocations, `emit Event(…)`,
// `new Contract(…)`, and `using Lib for T` all feed the calls resolver. Same-dir symbols share scope
// (see sharesDirScope): Solidity's flat project namespace makes plain `import "./Base.sol"` — which
// names no symbols — resolvable for siblings without guessing; cross-dir plain imports still produce
// the file-level import edge, so blast radius stays correct even where symbol edges are unknowable.
import { specToPkg } from "./spec-pkg.js";

const CONTAINERS = new Set(["contract_declaration", "interface_declaration", "library_declaration"]);
const KIND_BY_CONTAINER = {
  contract_declaration: "contract",
  interface_declaration: "interface",
  library_declaration: "library",
};
// external/public functions are the deployed ABI — callable by any transaction, not just repo code.
const VISIBILITY = { external: "public", public: "public", internal: "protected", private: "private" };

function enclosingContainer(node) {
  for (let parent = node?.parent; parent; parent = parent.parent) {
    if (CONTAINERS.has(parent.type)) return parent;
  }
  return null;
}

const identifierOf = (node) => node?.namedChildren?.find((child) => child.type === "identifier") || null;
const childOfType = (node, type) => node?.namedChildren?.find((child) => child.type === type) || null;
const parameterCount = (node) => (node?.namedChildren || []).filter((child) => child.type === "parameter").length;

export default {
  family: "solidity",
  grammars: ["solidity"],
  exts: { ".sol": "solidity" },
  isWeb: false,
  calls: `[(call_expression (identifier) @callee) (modifier_invocation (identifier) @callee) (emit_statement (identifier) @callee) (new_expression (type_name (user_defined_type (identifier) @callee))) (using_directive (type_alias (identifier) @callee))]`,
  heritage: [`(inheritance_specifier (user_defined_type (identifier) @base))`],

  pass1(ctx) {
    const { grammar, tree, fileRel, caps, addSym, addImportEdge, addExternalImport, imports, links, nameToId, resolveSolidityImport } = ctx;

    // ---- containers (contract/interface/library) ----
    for (const cap of caps(grammar, `[(contract_declaration (identifier) @c) (interface_declaration (identifier) @c) (library_declaration (identifier) @c)]`, tree.rootNode)) {
      addSym(cap.node.text, cap.node.startPosition.row + 1, false, {
        sourceNode: cap.node.parent,
        selectionNode: cap.node,
        symbolKind: KIND_BY_CONTAINER[cap.node.parent.type],
        symbolSpace: "both",
        exported: true,
        moduleDeclaration: true,
      });
    }

    // ---- functions (free + members), constructors, modifiers ----
    const ownedMembers = [];
    const addMember = (name, node, selection, extra) => {
      const container = enclosingContainer(node);
      const ownerName = container ? identifierOf(container)?.text || null : null;
      const id = addSym(name, (selection || node).startPosition.row + 1, extra.callable !== false, {
        sourceNode: node,
        selectionNode: selection || undefined,
        ...(ownerName ? { memberOf: ownerName } : { exported: true, moduleDeclaration: true }),
        ...extra,
      });
      if (ownerName && id) ownedMembers.push({ ownerName, id });
      return id;
    };
    for (const cap of caps(grammar, `(function_definition (identifier) @fn)`, tree.rootNode)) {
      const definition = cap.node.parent;
      const visibility = VISIBILITY[childOfType(definition, "visibility")?.text || ""];
      addMember(cap.node.text, definition, cap.node, {
        symbolKind: enclosingContainer(definition) ? "method" : "function",
        ...(visibility ? { visibility } : {}),
        parameterCount: parameterCount(definition),
      });
    }
    for (const cap of caps(grammar, `(constructor_definition) @ctor`, tree.rootNode))
      addMember("constructor", cap.node, null, { symbolKind: "constructor", parameterCount: parameterCount(cap.node) });
    for (const cap of caps(grammar, `(modifier_definition (identifier) @m)`, tree.rootNode))
      addMember(cap.node.text, cap.node.parent, cap.node, { symbolKind: "modifier", parameterCount: parameterCount(cap.node.parent) });

    // ---- data/type declarations ----
    for (const cap of caps(grammar, `[(event_definition (identifier) @n) (error_declaration (identifier) @n)]`, tree.rootNode))
      addMember(cap.node.text, cap.node.parent, cap.node, { callable: false, symbolKind: cap.node.parent.type === "event_definition" ? "event" : "error" });
    for (const cap of caps(grammar, `[(struct_declaration (identifier) @n) (enum_declaration (identifier) @n)]`, tree.rootNode))
      addMember(cap.node.text, cap.node.parent, cap.node, { callable: false, symbolKind: cap.node.parent.type === "struct_declaration" ? "struct" : "enum", symbolSpace: "both" });
    // capture the DECLARATION and take its first identifier child (the name): an initializer such as
    // `uint x = OTHER_CONST;` can place a second bare identifier under the same declaration node.
    for (const cap of caps(grammar, `(constant_variable_declaration) @d`, tree.rootNode)) {
      const name = identifierOf(cap.node);
      if (name) addMember(name.text, cap.node, name, { callable: false, symbolKind: "constant" });
    }
    for (const cap of caps(grammar, `(state_variable_declaration) @d`, tree.rootNode)) {
      const name = identifierOf(cap.node);
      const visibility = VISIBILITY[childOfType(cap.node, "visibility")?.text || ""] || "protected"; // Solidity default: internal
      if (name) addMember(name.text, cap.node, name, { callable: false, symbolKind: "variable", visibility });
    }
    for (const member of ownedMembers) {
      const ownerId = nameToId.get(member.ownerName);
      if (ownerId) links.push({ source: ownerId, target: member.id, relation: "contains", confidence: "EXTRACTED" });
    }

    // ---- imports ----
    for (const cap of caps(grammar, `(import_directive) @imp`, tree.rootNode)) {
      const specNode = childOfType(cap.node, "string");
      if (!specNode) continue;
      const spec = specNode.text.replace(/^["']|["']$/g, "");
      const line = specNode.startPosition.row + 1;
      const target = resolveSolidityImport(fileRel, spec);
      if (target) {
        addImportEdge(target, { specifier: spec, line });
        // `import {A, B} from "./x.sol"` — bind each named symbol. A lone identifier may instead be a
        // `* as Alias` namespace name; binding it the same way is harmless (no same-named symbol → no edge).
        for (const named of cap.node.namedChildren.filter((child) => child.type === "identifier"))
          imports.set(named.text, { imported: named.text, targetFile: target });
        continue;
      }
      if (spec.startsWith(".")) { addExternalImport({ spec, kind: "sol-import", line, unresolved: true }); continue; }
      const r = specToPkg(spec);
      if (r) addExternalImport({ spec, pkg: r.pkg, builtin: false, kind: "sol-import", line });
      else addExternalImport({ spec, kind: "sol-import", line, unresolved: true });
    }
  },
};
