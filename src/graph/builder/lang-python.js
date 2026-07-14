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
  calls: `(call function: (identifier) @callee)`,
  heritage: [`(class_definition superclasses: (argument_list (identifier) @super))`],

  pass1(ctx) {
    const { grammar, tree, fileRel, caps, field, addSym, addImportEdge, addExternalImport, imports, resolvePyPath, pyBaseDir, pyTopDirs } = ctx;
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
    for (const cap of caps(grammar, `(function_definition name: (identifier) @fn) (class_definition name: (identifier) @class)`, tree.rootNode)) {
      const decorated = cap.node.parent?.parent?.type === "decorated_definition";
      addSym(cap.node.text, cap.node.startPosition.row + 1, cap.name === "fn", {
        sourceNode: cap.node.parent,
        ...(decorated ? { decorated: true } : {})
      });
    }
    for (const cap of caps(grammar, `(module (expression_statement (assignment left: (identifier) @var)))`, tree.rootNode))
      addSym(cap.node.text, cap.node.startPosition.row + 1, false, { sourceNode: cap.node.parent });

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
};
