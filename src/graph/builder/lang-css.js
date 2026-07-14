// CSS / SCSS / LESS extractor (web reference graph, not a call graph — orchestrator skips pass 2 for it).
// Symbols: class/id selectors (indexed in selectorIndex so HTML class/id usage can reference the file).
// Imports: `@import "x.css"`. NOTE: no dedicated SCSS grammar in tree-sitter-wasms, so nested SCSS selectors
// are under-captured (files still appear as nodes + resolve JS `import styles from './x.scss'`).
export default {
  family: "css",
  grammars: ["css"],
  exts: { ".css": "css", ".scss": "css", ".less": "css" },
  isWeb: true,
  calls: "",
  heritage: [],

  pass1(ctx) {
    const { grammar, tree, fileRel, caps, addNode, links, nodeIds, syms, selectorIndex, addImportEdge, resolveHref } = ctx;
    const addSel = (label, line) => {
      const id = `${fileRel}#${label}@${line}`;
      if (nodeIds.has(id)) return;
      addNode({ id, label, file_type: "code", source_file: fileRel, source_location: `L${line}` });
      links.push({ source: fileRel, target: id, relation: "contains", confidence: "EXTRACTED" });
      syms.push({ id, name: label, start: line });
      let s = selectorIndex.get(label); if (!s) selectorIndex.set(label, (s = new Set())); s.add(fileRel);
    };
    for (const cap of caps(grammar, `(class_selector (class_name) @c)`, tree.rootNode)) addSel("." + cap.node.text, cap.node.startPosition.row + 1);
    for (const cap of caps(grammar, `(id_selector (id_name) @i)`, tree.rootNode)) addSel("#" + cap.node.text, cap.node.startPosition.row + 1);
    for (const cap of caps(grammar, `(import_statement (string_value) @s)`, tree.rootNode)) {
      const tgt = resolveHref(fileRel, cap.node.text.replace(/^["']|["']$/g, "")); if (tgt) addImportEdge(tgt);
    }
  },
};
