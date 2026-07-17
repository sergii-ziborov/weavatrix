// Python extractor. Symbols: def/class (methods included) + module-level assignments (data consts).
// Imports: `import a.b [as c]` and `from [.]*mod import name [as alias]` with dotted + relative (leading-dot)
// resolution to <path>.py / <path>/__init__.py — tried from the repo root, src/ (src-layout), and the
// importing file's own directory (script-style sys.path). Absolute imports that resolve to NO repo file
// are recorded as external imports (stdlib → builtin, else ecosystem "PyPI") for dependency analysis.
// Calls: bare `foo()`. Heritage: class superclasses.
import { pySpecToPkg, PY_STDLIB } from "./spec-pkg.js";

export default {
  family: "py",
  grammars: ["python"],
  exts: { ".py": "python", ".pyi": "python" },
  isWeb: false,
  customCalls: true,
  calls: `(call function: (identifier) @callee)`,
  heritage: [`(class_definition superclasses: (argument_list (identifier) @super))`],

  pass1(ctx) {
    const { grammar, tree, fileRel, code, caps, field, addSym, addImportEdge, addExternalImport, markExported, imports, links, nameToId, resolvePyPath, pyBaseDir, pyTopDirs } = ctx;
    // the importing file's own dir is on sys.path when it runs as a script — try siblings for absolute
    // imports, EXCEPT stdlib names (a sibling logging.py must not shadow `import logging`; py3 absolute
    // imports always pick the stdlib, and a wrong internal edge distorts dead-code + reachability)
    const scriptDir = pyBaseDir(fileRel, 1);
    const resolveAbs = (parts) => resolvePyPath("", parts) || (scriptDir && !PY_STDLIB.has(parts[0]) ? resolvePyPath(scriptDir, parts) : null);
    const recordExternal = (dottedName, line) => {
      const top = String(dottedName).split(".")[0];
      if (pyTopDirs && pyTopDirs.has(top)) return; // repo-local namespace package (no __init__.py) — internal, not a dep
      const r = pySpecToPkg(top);
      if (r && !r.ambiguous) addExternalImport({ spec: dottedName, pkg: r.pkg, builtin: r.builtin, ecosystem: "PyPI", kind: "py-import", line });
    };

    // ---- symbols (decorated defs are framework-entered — @app.route/@app.event/@pytest.fixture — the
    // flag keeps dead-code checks from calling them dead; tree wraps them in decorated_definition) ----
    const ownedMethods = [];
    for (const cap of caps(grammar, `(function_definition name: (identifier) @fn) (class_definition name: (identifier) @class)`, tree.rootNode)) {
      const decorated = cap.node.parent?.parent?.type === "decorated_definition";
      let ownerName = null;
      if (cap.name === "fn") {
        let parent = cap.node.parent?.parent;
        while (parent && !["function_definition", "class_definition", "module"].includes(parent.type)) parent = parent.parent;
        if (parent?.type === "class_definition") ownerName = field(parent, "name")?.text || null;
      }
      const visibility = /^__[^_].*/.test(cap.node.text) ? "private"
        : /^_[^_]/.test(cap.node.text) ? "protected" : "public";
      const id = addSym(cap.node.text, cap.node.startPosition.row + 1, cap.name === "fn", {
        sourceNode: cap.node.parent,
        selectionNode: cap.node,
        ...(decorated ? { decorated: true } : {}),
        symbolKind: cap.name === "class" ? "class" : ownerName ? "method" : "function",
        ...(ownerName ? {memberOf: ownerName, visibility} : {moduleDeclaration: true}),
      });
      if (ownerName) ownedMethods.push({ownerName, id});
    }
    for (const method of ownedMethods) {
      const ownerId = nameToId.get(method.ownerName);
      if (ownerId) links.push({source: ownerId, target: method.id, relation: "contains", confidence: "EXTRACTED"});
    }
    for (const cap of caps(grammar, `(module (expression_statement (assignment left: (identifier) @var)))`, tree.rootNode))
      addSym(cap.node.text, cap.node.startPosition.row + 1, false, { sourceNode: cap.node.parent, selectionNode: cap.node, symbolKind: "variable", moduleDeclaration: true });

    // Static __all__ is authoritative for wildcard imports. The assignment itself remains indexed,
    // while listed declarations are marked as the explicit public module surface.
    const allMatch = String(code || "").match(/(?:^|\n)\s*__all__\s*=\s*[\[(]([\s\S]*?)[\])]/m);
    if (allMatch) for (const match of allMatch[1].matchAll(/["']([A-Za-z_]\w*)["']/g)) markExported(match[1]);

    // ---- import a.b [as c] ----
    for (const cap of caps(grammar, `(import_statement) @imp`, tree.rootNode)) {
      for (const child of cap.node.namedChildren) {
        const modNode = child.type === "aliased_import" ? field(child, "name") : (child.type === "dotted_name" ? child : null);
        if (!modNode) continue;
        const parts = modNode.text.split(".");
        const tgt = resolveAbs(parts);
        if (tgt) { addImportEdge(tgt); const local = child.type === "aliased_import" ? field(child, "alias")?.text : parts[0]; if (local) imports.set(local, { imported: "*", targetFile: tgt }); }
        else recordExternal(modNode.text, modNode.startPosition.row + 1);
      }
    }

    // ---- from [.]*mod import name [, name as alias] ----
    for (const cap of caps(grammar, `(import_from_statement) @imp`, tree.rootNode)) {
      const node = cap.node; const modNode = field(node, "module_name");
      let dots = 0, modParts = [];
      if (modNode) {
        if (modNode.type === "relative_import") { const t = modNode.text; while (dots < t.length && t[dots] === ".") dots++; const rest = t.slice(dots); modParts = rest ? rest.split(".") : []; }
        else if (modNode.type === "dotted_name") modParts = modNode.text.split(".");
      }
      const baseDir = pyBaseDir(fileRel, dots);
      const wildcard = node.namedChildren.some((child) => child.type === "wildcard_import");
      if (wildcard) {
        const modFile = resolvePyPath(baseDir, modParts) || (dots === 0 ? resolveAbs(modParts) : null);
        if (modFile) {
          addImportEdge(modFile);
          imports.set(`*:${node.startPosition.row + 1}`, {imported: "*", targetFile: modFile, wildcard: true, line: node.startPosition.row + 1});
        } else if (dots === 0 && modParts.length) recordExternal(modParts.join("."), node.startPosition.row + 1);
        continue;
      }
      const names = node.namedChildren.filter((c) => c !== modNode && (c.type === "dotted_name" || c.type === "aliased_import"));
      let externalDone = false; // one record per statement, not per imported name
      for (const nm of names) {
        const impName = nm.type === "aliased_import" ? field(nm, "name")?.text : nm.text;
        const local = nm.type === "aliased_import" ? field(nm, "alias")?.text : impName;
        if (!impName) continue;
        const asSub = resolvePyPath(baseDir, [...modParts, impName]) || (dots === 0 ? resolveAbs([...modParts, impName]) : null);   // name may itself be a submodule file
        if (asSub) { addImportEdge(asSub); if (local) imports.set(local, { imported: "*", targetFile: asSub }); continue; }
        const modFile = resolvePyPath(baseDir, modParts) || (dots === 0 ? resolveAbs(modParts) : null);
        if (modFile) { addImportEdge(modFile); if (local) imports.set(local, { imported: impName, targetFile: modFile }); }
        else if (dots === 0 && modParts.length && !externalDone) { externalDone = true; recordExternal(modParts.join("."), node.startPosition.row + 1); }
      }
    }
  },

  pass2(ctx) {
    const {grammar, tree, fileRel, caps, field, enclosing, links, nodeById, perFileSymbols, symByFileName, importedLocals, resolveCall} = ctx;
    const imports = importedLocals.get(fileRel) || new Map();
    const wildcardImports = [...imports.values()].filter((entry) => entry?.wildcard && entry.targetFile);
    const emitted = new Set();
    const addCall = (caller, target, line, evidence) => {
      if (!caller || !target || target === caller.id) return;
      const key = `${caller.id}\0${target}\0${line}`;
      if (emitted.has(key) || links.some((link) => link.source === caller.id && link.target === target && link.relation === "calls" && link.line === line)) return;
      emitted.add(key);
      const provenance = ["receiver-type", "wildcard-import", "module-member"].includes(evidence) ? "RESOLVED" : "INFERRED";
      links.push({source: caller.id, target, relation: "calls", confidence: "INFERRED", provenance, line, pythonResolution: evidence});
    };
    const moduleSymbol = (targetFile, name) => {
      const id = symByFileName.get(targetFile)?.get(name);
      if (!id) return null;
      const node = nodeById.get(id);
      return node?.member_of ? null : id;
    };
    const wildcardCandidates = (name) => {
      const candidates = [];
      for (const imp of wildcardImports) {
        const symbols = perFileSymbols.get(imp.targetFile) || [];
        const explicitAll = symbols.some((symbol) => symbol.name === "__all__");
        const symbol = symbols.find((entry) => entry.name === name && !entry.memberOf);
        if (!symbol || (explicitAll ? nodeById.get(symbol.id)?.exported !== true : name.startsWith("_"))) continue;
        candidates.push(symbol.id);
      }
      return [...new Set(candidates)];
    };
    const classInfo = (name) => {
      const local = symByFileName.get(fileRel)?.get(name);
      if (local && nodeById.get(local)?.symbol_kind === "class") return {id: local, name, file: fileRel};
      const imp = imports.get(name);
      if (imp?.targetFile && !imp.wildcard) {
        const targetFile = imp.originFile || imp.targetFile;
        const targetName = imp.originName || imp.imported || name;
        const id = symByFileName.get(targetFile)?.get(targetName);
        if (id && nodeById.get(id)?.symbol_kind === "class") return {id, name: targetName, file: targetFile};
      }
      const wildcard = wildcardCandidates(name).filter((id) => nodeById.get(id)?.symbol_kind === "class");
      if (wildcard.length === 1) {
        const node = nodeById.get(wildcard[0]);
        return {id: wildcard[0], name: node.label || name, file: node.source_file};
      }
      return null;
    };
    const methodOf = (klass, method) => (perFileSymbols.get(klass.file) || [])
      .find((symbol) => symbol.memberOf === String(nodeById.get(klass.id)?.label || klass.name).replace(/\(.*$/, "") && symbol.name === method)?.id || null;
    const bindings = new Map();
    const shadows = new Set();
    const scopeKey = (caller, name) => `${caller?.id || ""}\0${name}`;
    const bind = (caller, name, klass) => { if (caller && name && klass) bindings.set(scopeKey(caller, name), klass); };
    const typeName = (node) => {
      const text = String(node?.text || "").replace(/^['"]|['"]$/g, "");
      return (text.match(/[A-Za-z_]\w*/) || [])[0] || "";
    };

    for (const cap of caps(grammar, `(parameters (identifier) @param) (typed_parameter) @typed`, tree.rootNode)) {
      const line = cap.node.startPosition.row + 1;
      const caller = enclosing(fileRel, line);
      if (!caller) continue;
      if (cap.name === "param") {
        shadows.add(scopeKey(caller, cap.node.text));
        continue;
      }
      const name = cap.node.namedChildren.find((child) => child.type === "identifier")?.text;
      if (!name) continue;
      shadows.add(scopeKey(caller, name));
      bind(caller, name, classInfo(typeName(field(cap.node, "type"))));
    }
    for (const cap of caps(grammar, `(assignment) @assign`, tree.rootNode)) {
      const assignment = cap.node;
      const caller = enclosing(fileRel, assignment.startPosition.row + 1);
      if (!caller) continue;
      const left = field(assignment, "left");
      const right = field(assignment, "right");
      let receiver = "";
      if (left?.type === "identifier") receiver = left.text;
      else if (left?.type === "attribute") receiver = left.text;
      if (!receiver) continue;
      shadows.add(scopeKey(caller, receiver));
      const annotation = typeName(field(assignment, "type"));
      const constructor = right?.type === "call" && field(right, "function")?.type === "identifier"
        ? field(right, "function").text : "";
      bind(caller, receiver, classInfo(annotation || constructor));
    }

    for (const cap of caps(grammar, `(call function: (identifier) @callee)`, tree.rootNode)) {
      const line = cap.node.startPosition.row + 1;
      const caller = enclosing(fileRel, line);
      if (!caller || shadows.has(scopeKey(caller, cap.node.text))) continue;
      let target = resolveCall(cap.node.text, fileRel);
      if (target && nodeById.get(target)?.member_of) target = null;
      let evidence = "bare";
      if (!target) {
        const candidates = wildcardCandidates(cap.node.text);
        if (candidates.length === 1) { target = candidates[0]; evidence = "wildcard-import"; }
      }
      addCall(caller, target, line, evidence);
    }

    for (const cap of caps(grammar, `(call function: (attribute) @attributeCall)`, tree.rootNode)) {
      const attribute = cap.node;
      const object = field(attribute, "object");
      const member = field(attribute, "attribute");
      if (!object || !member) continue;
      const line = attribute.startPosition.row + 1;
      const caller = enclosing(fileRel, line);
      if (!caller) continue;
      if (object.type === "identifier") {
        const moduleImport = imports.get(object.text);
        if (moduleImport?.targetFile && moduleImport.imported === "*" && !moduleImport.wildcard) {
          addCall(caller, moduleSymbol(moduleImport.targetFile, member.text), line, "module-member");
          continue;
        }
      }
      let klass = null;
      if (["self", "cls"].includes(object.text) && caller.memberOf) klass = classInfo(caller.memberOf);
      if (!klass) klass = bindings.get(scopeKey(caller, object.text));
      if (!klass && object.type === "call" && field(object, "function")?.type === "identifier") klass = classInfo(field(object, "function").text);
      addCall(caller, klass && methodOf(klass, member.text), line, "receiver-type");
    }
  },
};
